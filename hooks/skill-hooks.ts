/**
 * ForgeOS Skill Hooks
 * Pre and post execution hooks wrapping every skill call
 * Enforces harness patterns: context loading, signal collection, memory GC
 */

import type { SkillContext, SkillResult, SignalSchema } from './types'


// ─── PRE-SKILL HOOKS ──────────────────────────────────────────────────────────

/**
 * context_loader
 * Tiered memory injection: compact index (always) + on-demand topic files
 * Pattern M-01 + M-02 from harness spec
 */
export async function context_loader(ctx: SkillContext): Promise<SkillContext> {
  const { project_id, skill_name } = ctx

  // Layer 1: Always-in-context compact index (max 200 lines from DO SQLite)
  const compact = await ctx.do.storage.get<string>('memory:compact')

  // Layer 2: Skill-specific memory (load on demand from Vectorize)
  const skillMemory = await ctx.vectorize.query(
    `${skill_name} patterns pitfalls decisions`,
    { topK: 5, filter: { project_id } }
  )

  // Layer 3: OSS pattern corpus (from RIS ingestion)
  const ossPatterns = await ctx.vectorize.query(
    `${skill_name} best practices`,
    { topK: 3, filter: { source: 'oss_corpus' } }
  )

  // Layer 4: Meta-patterns (cross-project failures)
  const metaPatterns = await ctx.vectorize.query(
    `${skill_name} failure pitfall avoid`,
    { topK: 3, filter: { source: 'meta_patterns', severity: { gt: 0.6 } } }
  )

  ctx.injected_context = [
    compact ?? '',
    ...skillMemory.matches.map(m => m.metadata.text),
    ...ossPatterns.matches.map(m => `[OSS Pattern] ${m.metadata.text}`),
    ...metaPatterns.matches.map(m => `[Known Pitfall] ${m.metadata.text}`),
  ].join('\n\n')

  return ctx
}


/**
 * token_counter
 * Count context tokens before LLM call. Trigger compaction if >80% fill.
 * Pattern M-04: Context Compaction
 */
export async function token_counter(ctx: SkillContext): Promise<SkillContext> {
  const estimatedTokens = estimateTokens(ctx.injected_context + ctx.prompt)
  const MODEL_LIMITS: Record<string, number> = {
    'cf-workers-ai/kimi-k2.5': 200000,
    'groq/llama-3.3-70b': 128000,
    'openrouter/best': 128000,
  }

  const limit = MODEL_LIMITS[ctx.model] ?? 128000
  const fillPct = estimatedTokens / limit

  if (fillPct > 0.80) {
    // Compact: summarise conversation history, keep last 3 messages verbatim
    ctx.conversation = await compactConversation(ctx.conversation, {
      keep_last_n: 3,
      summary_model: 'groq/llama-3.3-70b',   // cheap for summarisation
    })
    ctx.context_compacted = true
  }

  ctx.token_count = estimatedTokens
  ctx.fill_pct = fillPct
  return ctx
}


/**
 * trust_check
 * Enforce tool permission tiers per project trust triad
 * Pattern T-10: Trust Triad (per repo)
 */
export async function trust_check(ctx: SkillContext): Promise<SkillContext> {
  const trust = await ctx.do.storage.get<TrustConfig>('trust:config') ?? DEFAULT_TRUST

  // Block any denied tool calls before they reach the skill
  ctx.allowed_tools = SKILL_TOOLS[ctx.skill_name].filter(tool => {
    if (trust.deny.includes(tool)) return false
    if (trust.readonly.includes(tool) && MUTATING_TOOLS.includes(tool)) return false
    return true
  })

  ctx.trust_config = trust
  return ctx
}


/**
 * oss_pattern_inject
 * Pull relevant OSS patterns from RIS corpus into skill context
 * Used by review, plan-eng-review, cso
 */
export async function oss_pattern_inject(ctx: SkillContext): Promise<SkillContext> {
  const { diff, skill_name } = ctx

  if (!diff) return ctx

  // Detect tech stack from diff file extensions
  const stack = detectStack(diff)

  // Query OSS corpus for this stack + skill combination
  const patterns = await ctx.vectorize.query(
    `${skill_name} ${stack.join(' ')} patterns`,
    { topK: 5, filter: { source: 'oss_corpus', verified: true } }
  )

  const injected = patterns.matches
    .filter(m => m.score > 0.75)           // only high-relevance patterns
    .map(m => `[${m.metadata.repo}] ${m.metadata.text}`)
    .join('\n')

  ctx.injected_context += '\n\n## Relevant OSS Patterns\n' + injected
  return ctx
}


/**
 * playwright_boot
 * Start Playwright in sandbox container before QA skill runs
 */
export async function playwright_boot(ctx: SkillContext): Promise<SkillContext> {
  const sandboxId = ctx.sprint.sandbox_id

  // Signal sandbox coordinator to boot Playwright
  const response = await fetch(`${SANDBOX_COORDINATOR_URL}/playwright/start`, {
    method: 'POST',
    body: JSON.stringify({ sandbox_id: sandboxId }),
    headers: { 'Authorization': `Bearer ${ctx.env.SANDBOX_SECRET}` },
  })

  if (!response.ok) {
    ctx.playwright_ready = false
    ctx.abort_reason = 'INFRA_FAILURE: Playwright could not start'
    return ctx
  }

  const { ws_endpoint, browser_id } = await response.json()
  ctx.playwright_ws = ws_endpoint
  ctx.browser_id = browser_id
  ctx.playwright_ready = true
  return ctx
}


// ─── POST-SKILL HOOKS ─────────────────────────────────────────────────────────

/**
 * signal_collector
 * Extract structured signals from skill output, store in PostgreSQL
 * Feeds the RL reward function
 */
export async function signal_collector(
  ctx: SkillContext,
  result: SkillResult
): Promise<void> {
  const signals = extractSignals(ctx.skill_name, result)

  // Write to PostgreSQL signal table
  await ctx.db.execute(
    `INSERT INTO sprint_signals
     (sprint_id, project_id, skill_name, signals, raw_verdict, ts)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [ctx.sprint_id, ctx.project_id, ctx.skill_name,
     JSON.stringify(signals), result.verdict]
  )

  // Update Durable Object sprint state
  await ctx.do.storage.put(`signal:${ctx.skill_name}`, signals)
}


/**
 * reward_update
 * Compute reward for this skill call, update skill version score in Qdrant
 * Core RL loop: R = weighted sum of signals
 */
export async function reward_update(
  ctx: SkillContext,
  result: SkillResult
): Promise<void> {
  const WEIGHTS: Record<string, number> = {
    test_pass_rate:    0.35,
    lint_score:        0.15,
    typecheck_pass:    0.15,
    deploy_success:    0.20,
    canary_clean:      0.10,
    user_accept:       0.05,
  }

  // Retrieve all signals for this sprint from DO
  const allSignals = await ctx.do.storage.list({ prefix: 'signal:' })
  const flatSignals: Record<string, number> = {}
  for (const [, v] of allSignals) {
    Object.assign(flatSignals, v)
  }

  // Compute reward
  const R = Object.entries(WEIGHTS).reduce((sum, [key, w]) => {
    return sum + w * (flatSignals[key] ?? 0)
  }, 0)

  // Update skill version reward history in Qdrant
  const skillVersionId = await getActiveSkillVersion(ctx.skill_name)
  await ctx.vectorize.upsert([{
    id: `reward:${skillVersionId}:${ctx.sprint_id}`,
    values: await embed(`reward signal for ${ctx.skill_name}`),
    metadata: {
      skill_name: ctx.skill_name,
      skill_version_id: skillVersionId,
      reward: R,
      sprint_id: ctx.sprint_id,
      project_id: ctx.project_id,
      ts: Date.now(),
    }
  }])

  // Check if GRPO-lite eval should trigger (every 10 sprints)
  const sprintCount = await ctx.db.queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM sprint_signals WHERE skill_name = $1',
    [ctx.skill_name]
  )

  if (sprintCount.count % 10 === 0) {
    await ctx.queue.send('grpo-eval', {
      skill_name: ctx.skill_name,
      trigger_sprint: ctx.sprint_id,
    })
  }
}


/**
 * checkpoint_commit
 * WIP commit with structured [forge-context] body after each skill
 * Pattern A-11: Checkpoint Commits
 */
export async function checkpoint_commit(
  ctx: SkillContext,
  result: SkillResult
): Promise<void> {
  const contextBody = JSON.stringify({
    skill: ctx.skill_name,
    verdict: result.verdict,
    decisions: result.architecture_decisions ?? [],
    remaining: result.next_steps ?? [],
    failed_approaches: result.failed_approaches ?? [],
    ts: new Date().toISOString(),
  }, null, 2)

  await ctx.sandbox.exec([
    'git', 'add', '-A',
    '&&',
    'git', 'commit', '--allow-empty',
    '-m', `WIP: ${ctx.skill_name} [${result.verdict}]`,
    '-m', `[forge-context]\n${contextBody}`,
  ])
}


/**
 * kv_update
 * Write skill output summary to CF KV for fast reads by UI
 */
export async function kv_update(
  ctx: SkillContext,
  result: SkillResult
): Promise<void> {
  await ctx.kv.put(
    `sprint:${ctx.sprint_id}:${ctx.skill_name}`,
    JSON.stringify({
      verdict: result.verdict,
      summary: result.summary ?? null,
      ts: Date.now(),
    }),
    { expirationTtl: 86400 * 7 }           // 7-day TTL
  )
}


/**
 * screenshot_archive_r2
 * Push Playwright screenshots to CF R2 after QA skill
 */
export async function screenshot_archive_r2(
  ctx: SkillContext,
  result: SkillResult
): Promise<void> {
  const screenshots = await ctx.sandbox.listFiles('screenshots/')

  for (const file of screenshots) {
    const content = await ctx.sandbox.readFile(file)
    await ctx.r2.put(
      `sprints/${ctx.sprint_id}/screenshots/${file}`,
      content,
      { httpMetadata: { contentType: 'image/png' } }
    )
  }

  result.screenshot_urls = screenshots.map(f =>
    `${ctx.env.R2_PUBLIC_URL}/sprints/${ctx.sprint_id}/screenshots/${f}`
  )
}


/**
 * dream_consolidation_gc (background job)
 * Deduplicates and compresses long-term memory in Durable Object
 * Pattern M-03: Dream Consolidation
 * Runs BETWEEN sprints, not during
 */
export async function dream_consolidation_gc(project_id: string): Promise<void> {
  const doId = getDurableObjectId(project_id)
  const allMemory = await doId.storage.list({ prefix: 'memory:' })

  const memories = Array.from(allMemory.values()) as MemoryEntry[]

  // Find near-duplicates (cosine similarity > 0.95)
  const embeddings = await Promise.all(
    memories.map(m => embed(m.text))
  )

  const duplicates = findDuplicates(embeddings, { threshold: 0.95 })

  // Merge duplicates, keep most recent
  for (const [a, b] of duplicates) {
    const merged = await mergeMemories(memories[a], memories[b])
    await doId.storage.put(`memory:${merged.id}`, merged)
    await doId.storage.delete(`memory:${memories[b].id}`)
  }

  // Compact to 200-line index
  const compactIndex = await generateCompactIndex(memories, { max_lines: 200 })
  await doId.storage.put('memory:compact', compactIndex)
}

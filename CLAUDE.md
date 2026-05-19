# ForgeOS — Agent Instructions

This is the ForgeOS repository. It is an AI-native autonomous build platform
built on the gstack skill pattern with RLVR reward engine and meta-learning.

## Stack (LOCKED — do not suggest changes)

- **Edge**: Cloudflare Workers + Durable Objects + Dynamic Workflows + Workers AI
- **Compute**: Oracle ARM Always Free (Docker + gVisor sandboxes)
- **Backend**: FastAPI (sandbox coordinator only, not API gateway)
- **Frontend**: SvelteKit + shadcn-svelte + Tailwind (Cloudflare Pages)
- **AI routing**: LiteLLM 5-tier (CF Workers AI → Groq → OpenRouter → KiloCode → Anthropic)
- **Vector store**: Qdrant (deep batch) + CF Vectorize (hot-path queries)
- **Queue**: CF Queues (sprint DAG) + KeyDB (sandbox coordination)
- **Storage**: PostgreSQL (source of truth) + CF R2 (artifacts) + CF KV (skill cache)

## Skill architecture

Each skill in `/skills/*/SKILL.md` follows this structure:
1. YAML frontmatter: name, role, tier, model, fallback, timeout, signals, triggers, hooks
2. Role definition: who the agent IS, not what it does
3. Hard constraints: what it NEVER does
4. Reasoning Protocol: `<cot>` block with sequential steps the model must follow
5. Output format: exact schema with named sections
6. Pass/Fail contract: when this skill returns PASS vs FAIL
7. Signal schema: JSON of signals collected for RL reward

## Critical rules

- Multi-tenant safety: every DB query MUST have `WHERE project_id = ?`
- Trust triad: tool permissions enforced at harness level, not prompt level
- Checkpoint commits: every skill gate creates a WIP commit with [forge-context] body
- Context compaction: trigger at 80% fill, keep last 3 messages verbatim
- OSS pattern injection: auto-injects relevant patterns from corpus before skill call
- Dream GC: runs BETWEEN sprints, never during

## RL engine

- Signal collection: every sprint completion writes to `sprint_signals` table
- Reward function: R = 0.35·test_pass + 0.15·lint + 0.15·typecheck + 0.20·deploy + 0.10·canary + 0.05·user_accept
- GRPO eval: triggered every 10 sprints per skill via CF Queue
- Anthropic Batch API (50% discount) used for GRPO eval — never real-time for eval
- Qdrant `skill_prompts` collection stores all variants with reward_history[]

## Removed tools (do not suggest)

- ZeroClaw — permanently removed
- Dify — AGPL multi-tenant licensing blocker
- Vercel AI SDK — wrong architecture fit
- localStorage/sessionStorage — not supported in CF Workers context

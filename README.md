# ForgeOS

**AI-native autonomous build platform for developers and vibe coders.**

gstack-derived role-locked agent harness · RLVR reward engine · self-learning OSS corpus · edge-native on Cloudflare · zero-cost Oracle ARM compute.

Full loop: **spec → plan → build → review → test → deploy → monitor → learn.**

---

## What it is

ForgeOS turns a plain-English sprint spec into a production-ready, tested, deployed feature — without you touching the terminal.

It is not a code generator. It is a virtual engineering team with seven specialist roles, a harness that enforces their decisions, and a reinforcement learning engine that gets smarter from every sprint.

```
"Add a revenue dashboard with weekly breakdown and CSV export"
  ↓
/office-hours   — YC Partner pressure-tests the assumption
/autoplan       — CEO + Eng + Design review in parallel
[human gate]    — you approve the plan in one click
sandbox build   — code written, tested, linted, typechecked
/review         — Staff Engineer finds and fixes production bugs
/qa + /cso      — Playwright browser test + OWASP security audit in parallel
[human gate]    — you approve the PR diff
/ship           — Release Engineer merges, deploys, verifies production
/canary         — 30-minute post-deploy monitoring
RL signal       — reward computed, skill prompts improve
```

---

## Who it is for

**Vibe coders** — describe what you want in English. ForgeOS ships it tested and deployed. No CLI, no terminal, no code review required.

**Solo technical founders** — run 10–15 parallel sprints simultaneously. ForgeOS is the engineering team you cannot afford to hire.

**Digital agencies** — one Pro account, all client projects. Patterns learned from one restaurant client auto-inject into all restaurant clients. RL compounds across your portfolio.

**Junior developers** — /review catches what you missed. /cso flags OWASP issues before they reach production. /plan-eng-review produces the architecture doc you couldn't write alone.

---

## The 14 skills

| # | Skill | Role | What it does |
|---|---|---|---|
| 1 | `/office-hours` | YC Partner | 6 forcing questions that pressure-test the assumption before a line is written |
| 2 | `/plan-ceo-review` | CEO/Founder | Scope decision in 4 modes: EXPAND / SELECTIVE / HOLD / REDUCE |
| 3 | `/plan-eng-review` | Eng Manager | Data flow, 7 edge cases, multi-tenant audit, test matrix, build order |
| 4 | `/plan-design-review` | Senior Designer | 0–10 ratings per design dimension, AI slop detection |
| 5 | `/autoplan` | Orchestrator | Parallel CEO + Eng + Design fork-join with human gate |
| 6 | `/review` | Staff Engineer | P0–P3 bug detection, auto-fix, coverage audit, atomic commits |
| 7 | `/investigate` | Debugger | Root-cause analysis, data flow trace, 3-fix limit |
| 8 | `/qa` | QA Lead | Real Chromium browser, mobile viewport, regression tests, screenshot archive |
| 9 | `/cso` | Chief Security Officer | OWASP Top 10 + STRIDE, 17 false-positive exclusions, exploit paths required |
| 10 | `/ship` | Release Engineer | 10-step ship sequence: sync → changelog → CI → merge → tag → deploy → verify |
| 11 | `/canary` | SRE | Post-deploy: console errors, perf, failures — 30-minute monitoring window |
| 12 | `/benchmark` | Performance Engineer | Core Web Vitals, resource sizes, before/after diff |
| 13 | `/retro` | Eng Manager | Weekly retro, per-project streak tracking, shipping velocity |
| 14 | `/learn` | Memory Manager | Tiered memory GC, OSS pattern injection, meta-pattern promotion |

---

## Why the skills get smarter

ForgeOS implements **RLVR (Reinforcement Learning with Verifiable Rewards)** at the prompt level — the same technique used in DeepSeek R1, applied without weight updates or GPUs.

Every sprint generates verifiable signals:

| Signal | Weight | Source |
|---|---|---|
| `test_pass_rate` | 35% | Sandbox test runner exit code |
| `deploy_success` | 20% | Coolify webhook |
| `lint_score` | 15% | ESLint/Biome exit code |
| `typecheck_pass` | 15% | tsc/mypy exit code |
| `canary_clean` | 10% | Playwright post-deploy |
| `user_accept` | 5% | PR diff approval in UI |

Every 10 sprints, **GRPO-lite** evaluates 4 skill prompt variants against synthetic tasks, computes advantage scores, and promotes the winner. No human writes a prompt update.

Every 24 hours, the **meta-learning layer** clusters failure patterns across all projects. When 3+ projects hit the same failure mode, it auto-injects a "Known Pitfall" into relevant skill prompts. Patterns learned from one project benefit all projects.

---

## OSS corpus — how ForgeOS learns from the world's best code

ForgeOS clones and AST-parses high-signal OSS repositories nightly. Extracted patterns are embedded (fastembed BAAI/bge-base-en-v1.5) and stored in Qdrant. Before each skill call, relevant patterns are injected into context automatically.

Target corpus includes: `garrytan/gstack` · `calcom/cal.com` · `medusajs/medusa` · `OWASP/CheatSheetSeries` · `shadcn-ui/ui` · `microsoft/playwright` · `directus/directus` · `All-Hands-AI/OpenHands`

gstack is watched for new commits. When Garry ships a new skill or prompt update, ForgeOS ingests it, evaluates it against existing variants, and promotes it if it improves reward scores. ForgeOS is always ≥ gstack quality, automatically.

---

## Architecture

### Three-tier edge design

```
TIER 1 — Cloudflare Edge (near-zero cost · 335 PoPs)
  CF Workers          — API gateway, auth, routing, sub-1ms cold start
  Durable Objects     — one per project, actor model, hibernates when idle
  Dynamic Workflows   — sprint DAG, durable execution, waitForEvent human gates
  Workers AI          — Kimi K2.5, Llama 3.3 70B at edge, 77% cheaper than frontier
  AI Gateway          — caching layer, 40-60% prompt cache hit rate
  R2                  — artifact storage, zero egress fees
  Vectorize           — skill prompt vectors, taste profiles, meta-patterns

TIER 2 — Oracle ARM Always Free (heavy compute)
  Docker + gVisor     — isolated code execution, 2GB per sandbox, 8 concurrent
  PostgreSQL          — source of truth, signal history, skill versions
  Qdrant              — deep ML batch: GRPO eval, meta-pattern clustering
  FastAPI             — sandbox coordinator only (not API gateway)

TIER 3 — Overflow
  CF Sandboxes GA     — when Oracle hits 8 concurrent, seamless failover
  SNBD VPS            — secondary overflow, same Docker image
```

### LLM routing (5 tiers, cost-optimised)

| Tier | Provider | Model | Use case |
|---|---|---|---|
| 0 — Edge | CF Workers AI | Kimi K2.5 | Fast skill calls, routing, embeddings |
| 1 — Speed | Groq | Llama 3.3 70B | Plan reviews, fork-join jobs (free tier first) |
| 2 — Quality | OpenRouter | Best available | /review, /cso, /investigate |
| 3 — Cost | KiloCode Gateway | OpenAI-compatible | Volume inference |
| 4 — Premium | Anthropic Batch | Claude Sonnet 4 | GRPO eval (50% batch discount) |
| ∞ — Cache | CF AI Gateway | — | 40-60% cache hit on skill system prompts |

### Estimated monthly cost at 100 active projects, 6,000 sprints/day

```
CF Workers + Durable Objects + Workflows   ~$3-8
CF Workers AI (Tier-0, 40% of calls)      ~$5-12
Groq free tier (30% of calls)             $0
OpenRouter (20% of calls)                 ~$8-15
Anthropic Batch API (GRPO eval)           ~$3-5
CF R2 (50GB artifacts)                    ~$0.60
CF Vectorize (within free tier)           $0
Oracle ARM                                $0 (Always Free)
SNBD VPS                                  ~€5
─────────────────────────────────────────
Total                                     ~$30/month
```

Devin equivalent: ~$50,000/month.

---

## Harness patterns (12, from Claude Code source)

The harness is what separates ForgeOS from a folder of prompts.

| Category | Pattern | Implementation |
|---|---|---|
| Memory | Hierarchical rules (CLAUDE.md) | Global → project → directory scoped |
| Memory | Tiered memory index | 200-line DO compact + on-demand Vectorize |
| Memory | Dream Consolidation GC | Background dedup, cosine sim > 0.95 merge |
| Memory | Context compaction | Auto-summarise at 80% context fill |
| Workflow | Role-locked sub-agents | system_prompt enforced per job type |
| Workflow | Fork-join parallelism | asyncio.gather() with KeyDB semaphore |
| Workflow | Validation chain | Build → Review → QA+CSO → Ship DAG |
| Workflow | Specialist routing | LiteLLM 4-tier per skill tier metadata |
| Tools | Uniform tool interface | Pydantic v2 schema at every boundary |
| Tools | Trust triad (per repo) | read-write / read-only / deny enforced at harness |
| Automation | Checkpoint commits | WIP: prefix + [forge-context] body |
| Automation | Taste-decay learning | 5%/week decay, Vectorize per-project profile |

---

## Stress test plan

Five phases, each with a pass/fail contract before the next begins.

```
Phase 1 — Skill + Harness Validation        Weeks 1–2
  ✓ All 14 skills unit-tested
  ✓ Hook chain: 50 runs, 0 failures
  ✓ k6 API: p95 < 200ms at 100 VU

Phase 2 — Sprint Pipeline End-to-End        Weeks 3–4
  ✓ 15 parallel synthetic sprints, 0 dropped
  ✓ Oracle crash → CF Sandbox failover in < 2min
  ✓ 8 concurrent sandboxes, no OOM

Phase 3 — RL Engine + OSS Corpus            Weeks 5–8
  ✓ GRPO correctly promotes better variant ≥ 90% of time
  ✓ OSS pattern quality: ≥ 4/5 results relevant
  ✓ Meta-pattern injection: first pattern by Week 7

Phase 4 — Vibe Coder UI                     Weeks 9–12
  ✓ Non-technical user ships sprint without CLI or docs
  ✓ Mobile PR approval at 375px viewport
  ✓ MCP skill server returns REVIEW_REPORT in < 60s

Phase 5 — Launch Readiness                  Weeks 13–16
  ✓ All 10 launch thresholds pass
  ✓ Monthly infra cost < $50 at 100 projects
  ✓ Ratul user test: ships a sprint, no docs, no CLI
```

---

## Pricing

| Plan | Price | Sprints/day | Projects | RL Learning |
|---|---|---|---|---|
| Starter | £29/mo | 3 | 1 | Per-project |
| Growth | £59/mo | 10 | 5 | Per-project |
| Pro | £99/mo | Unlimited | Unlimited | Cross-project meta-learning |

---

## Install (local / self-hosted)

```bash
# Requirements: Bun v1.0+, Docker, gVisor (runsc), Cloudflare account

git clone https://github.com/rahlplx/forgeos.git
cd forgeos
bun install
cp .env.example .env   # fill in CF, Groq, Oracle, GitHub tokens

# Deploy CF Worker + Durable Objects
bunx wrangler deploy

# Start Oracle ARM sandbox coordinator
docker compose up -d sandbox-coordinator

# Seed skill registry with gstack baseline
bun run scripts/seed-skills.ts

# Run stress test (requires k6)
k6 run tests/stress/k6-stress.js
```

---

## Repository structure

```
forgeos/
├── skills/                  # 14 SKILL.md files — role-locked agent prompts
│   ├── office-hours/
│   ├── plan-ceo-review/
│   ├── plan-eng-review/
│   ├── plan-design-review/
│   ├── autoplan/
│   ├── review/
│   ├── investigate/
│   ├── qa/
│   ├── cso/
│   ├── ship/
│   ├── canary/
│   ├── benchmark/
│   ├── retro/
│   └── learn/
├── triggers/
│   └── sprint-workflow.ts   # CF Dynamic Workflow — full sprint DAG
├── hooks/
│   └── skill-hooks.ts       # 12 harness hooks — pre/post every skill call
├── rl/
│   └── grpo_eval.py         # GRPO-lite prompt selection engine
├── meta/                    # Meta-learning: OSS corpus, pattern extractor
├── tests/
│   ├── stress/
│   │   └── k6-stress.js     # 3-scenario k6 stress test
│   ├── unit/                # Skill unit tests
│   └── chaos/               # Oracle ARM failover, Groq storm, etc.
└── docs/                    # Architecture, API, deployment guides
```

---

## Relation to gstack

ForgeOS is built on top of [gstack](https://github.com/garrytan/gstack) (MIT) by Garry Tan, which provides the role-locked skill pattern, Think→Ship loop, and GBrain memory architecture.

ForgeOS adds:
- Multi-tenant SaaS wrapper (project_id isolation, billing, auth)
- RLVR reward engine (verifiable signals → GRPO-lite prompt selection)
- Meta-learning across projects (cross-project pattern extraction)
- OSS corpus (RIS — Repo Intelligence System — nightly repo ingestion)
- Edge-native architecture (CF Dynamic Workflows, Durable Objects, Workers AI)
- Vibe coder UI (no CLI required)
- MCP skill server (callable from Claude Code directly)

gstack skills are the baseline. ForgeOS diverges from that baseline as real sprint signals accumulate.

---

## Status

**Active development — Lab Launchpad, May 2026**

Phase 1 (skills + harness): in progress
Phase 2 (sprint pipeline): planned Week 3

Built by [@rahlplx](https://github.com/rahlplx) · [Lab Launchpad](https://lablaunchpad.com) · MIT

---

*"A single builder with the right tooling can move faster than a traditional team."*
*— Garry Tan, gstack*

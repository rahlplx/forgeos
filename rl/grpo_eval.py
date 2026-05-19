"""
ForgeOS RL Engine — GRPO-lite Prompt Selection
Triggered every 10 sprints per skill by reward_update hook
Runs off-peak via Anthropic Batch API (50% discount)

Algorithm:
  1. Pull top-N skill prompt variants from Qdrant
  2. Generate synthetic sprint tasks for this skill domain
  3. Run each variant against same tasks (N rollouts)
  4. Score each rollout on verifiable signals (RLVR)
  5. Compute GRPO advantage: A_i = (R_i - mean(R)) / std(R)
  6. Promote max(A_i) variant → skill registry active=True
  7. Deprecate variants with A_i < -0.5 for >3 consecutive evals
"""

import asyncio
import json
import statistics
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

# ─── Config ────────────────────────────────────────────────────────────────────

QDRANT_URL        = "http://localhost:6333"
QDRANT_COLLECTION = "skill_prompts"
N_VARIANTS        = 4              # GRPO group size
N_SYNTHETIC_TASKS = 5              # tasks per variant evaluation
DEPRECATE_THRESHOLD = -0.5         # A_i below this → deprecate candidate
DEPRECATE_STRIKES   = 3            # consecutive bad evals before deprecation
GROQ_BASE_URL     = "https://api.groq.com/openai/v1"
ANTHROPIC_BATCH   = "https://api.anthropic.com/v1/messages/batches"


@dataclass
class SkillVariant:
    variant_id: str
    skill_name: str
    prompt_text: str
    reward_history: list[float]
    eval_count: int
    active: bool
    strike_count: int   # consecutive evals with A_i < DEPRECATE_THRESHOLD
    source_repo: Optional[str] = None   # if imported from OSS corpus


@dataclass
class EvalResult:
    variant_id: str
    task_id: str
    reward: float
    signals: dict
    verdict: str


# ─── Signal extraction (RLVR — verifiable rewards only) ───────────────────────

VERIFIABLE_SIGNALS = {
    "test_pass_rate":  0.35,    # from sandbox test runner
    "lint_score":      0.15,    # from ESLint/Biome exit code
    "typecheck_pass":  0.15,    # from tsc/mypy exit code
    "deploy_success":  0.20,    # from Coolify webhook
    "canary_clean":    0.10,    # from Playwright post-deploy
    "user_accept":     0.05,    # from UI approval (only signal that's subjective)
}

def compute_reward(signals: dict) -> float:
    """
    R = weighted sum of verifiable signals
    No reward model needed — environment provides ground truth
    """
    return sum(
        VERIFIABLE_SIGNALS.get(k, 0) * float(v)
        for k, v in signals.items()
        if k in VERIFIABLE_SIGNALS
    )


# ─── Synthetic task generation ─────────────────────────────────────────────────

SYNTHETIC_TASKS_BY_SKILL = {
    "office-hours": [
        "Add Stripe subscription billing with 3 pricing tiers",
        "Build a CSV import feature for bulk user onboarding",
        "Add real-time notifications via WebSocket",
        "Create an admin dashboard with user management",
        "Add OAuth login with Google and GitHub",
    ],
    "plan-eng-review": [
        "Design the data model for a multi-tenant permission system",
        "Plan the API for a file upload service with virus scanning",
        "Architect a job queue for background email sending",
        "Design a rate limiting system per tenant",
        "Plan caching strategy for expensive DB aggregations",
    ],
    "review": [
        "Review authentication middleware for JWT handling",
        "Review a database migration adding tenant_id to 3 tables",
        "Review a new API endpoint for file uploads",
        "Review a refactored payment webhook handler",
        "Review async job queue implementation",
    ],
    "cso": [
        "Audit new user registration and login endpoints",
        "Audit file upload endpoint for injection risks",
        "Audit admin API for privilege escalation",
        "Audit webhook handler for HMAC verification",
        "Audit multi-tenant query layer for data leakage",
    ],
    "qa": [
        "Test user registration and email verification flow",
        "Test subscription upgrade and downgrade",
        "Test file upload with various file types and sizes",
        "Test admin user management CRUD",
        "Test real-time notification delivery",
    ],
}


# ─── GRPO-lite: Main evaluation loop ──────────────────────────────────────────

async def run_grpo_eval(skill_name: str, trigger_sprint_id: str) -> dict:
    """
    GRPO-lite prompt selection for a skill.
    No critic model. No weight updates. Pure prompt selection via reward comparison.
    """
    print(f"[GRPO] Starting eval for skill={skill_name}, trigger={trigger_sprint_id}")
    client = QdrantClient(url=QDRANT_URL)

    # 1. Pull top-N variants from Qdrant
    variants = await fetch_skill_variants(client, skill_name, n=N_VARIANTS)
    if len(variants) < 2:
        print(f"[GRPO] Only {len(variants)} variants found — skipping eval, need ≥2")
        return {"status": "skipped", "reason": "insufficient_variants"}

    print(f"[GRPO] Found {len(variants)} variants: {[v.variant_id for v in variants]}")

    # 2. Get synthetic tasks for this skill
    tasks = SYNTHETIC_TASKS_BY_SKILL.get(skill_name, [])[:N_SYNTHETIC_TASKS]
    if not tasks:
        print(f"[GRPO] No synthetic tasks for skill={skill_name}")
        return {"status": "skipped", "reason": "no_synthetic_tasks"}

    # 3. Run each variant against all tasks (via Anthropic Batch API — 50% discount)
    all_results: list[EvalResult] = []

    batch_requests = []
    for variant in variants:
        for i, task in enumerate(tasks):
            batch_requests.append({
                "custom_id": f"{variant.variant_id}::task_{i}",
                "params": {
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 2000,
                    "system": variant.prompt_text,
                    "messages": [{"role": "user", "content": task}],
                }
            })

    # Submit batch
    batch_id = await submit_anthropic_batch(batch_requests)
    print(f"[GRPO] Batch submitted: {batch_id}, waiting for completion...")

    # Poll batch (runs off-peak, 30-60 min)
    batch_results = await wait_for_batch(batch_id, poll_interval_secs=60)

    # 4. Score each result with verifiable signals (synthetic sandbox execution)
    for item in batch_results:
        variant_id, task_key = item["custom_id"].split("::")
        task_idx = int(task_key.split("_")[1])

        # Run synthetic sandbox to get verifiable signals
        signals = await run_synthetic_sandbox(
            skill_output=item["result"]["message"]["content"][0]["text"],
            skill_name=skill_name,
            task=tasks[task_idx],
        )

        reward = compute_reward(signals)
        all_results.append(EvalResult(
            variant_id=variant_id,
            task_id=task_key,
            reward=reward,
            signals=signals,
            verdict="pass" if reward > 0.6 else "fail",
        ))

    # 5. Compute per-variant mean reward
    variant_rewards: dict[str, list[float]] = {}
    for result in all_results:
        variant_rewards.setdefault(result.variant_id, []).append(result.reward)

    variant_means = {
        vid: statistics.mean(rewards)
        for vid, rewards in variant_rewards.items()
    }

    # 6. GRPO advantage: A_i = (R_i - mean(R)) / std(R)
    all_means = list(variant_means.values())
    group_mean = statistics.mean(all_means)
    group_std  = statistics.stdev(all_means) if len(all_means) > 1 else 1.0

    advantages = {
        vid: (mean - group_mean) / (group_std + 1e-8)
        for vid, mean in variant_means.items()
    }

    print(f"[GRPO] Advantages: {advantages}")

    # 7. Promote winner
    winner_id = max(advantages, key=advantages.get)
    winner_advantage = advantages[winner_id]

    print(f"[GRPO] Winner: {winner_id} (A={winner_advantage:.3f})")

    # Deactivate all variants, activate winner
    for variant in variants:
        is_winner = variant.variant_id == winner_id
        await update_variant_active(client, variant.variant_id, is_winner)
        await update_variant_reward_history(
            client, variant.variant_id,
            reward=variant_means.get(variant.variant_id, 0.0),
            advantage=advantages.get(variant.variant_id, 0.0),
        )

    # 8. Deprecate consistently poor variants
    deprecated = []
    for variant in variants:
        adv = advantages.get(variant.variant_id, 0.0)
        if adv < DEPRECATE_THRESHOLD:
            new_strikes = variant.strike_count + 1
            await update_variant_strikes(client, variant.variant_id, new_strikes)
            if new_strikes >= DEPRECATE_STRIKES:
                await deprecate_variant(client, variant.variant_id)
                deprecated.append(variant.variant_id)
                print(f"[GRPO] Deprecated: {variant.variant_id} ({new_strikes} strikes)")

    return {
        "status": "completed",
        "skill_name": skill_name,
        "variants_evaluated": len(variants),
        "winner": winner_id,
        "winner_advantage": winner_advantage,
        "winner_mean_reward": variant_means[winner_id],
        "deprecated": deprecated,
        "all_advantages": advantages,
        "ts": datetime.utcnow().isoformat(),
    }


# ─── Synthetic sandbox: verifiable signal extraction ──────────────────────────

async def run_synthetic_sandbox(
    skill_output: str,
    skill_name: str,
    task: str,
) -> dict:
    """
    For synthetic eval: extract verifiable signals from skill output
    without running an actual Docker sandbox.
    Uses heuristics + LLM-as-judge for non-binary signals.
    """
    signals = {}

    # Binary signals from output parsing
    signals["typecheck_pass"] = float(
        "TypeScript" not in skill_output.lower() or
        "type error" not in skill_output.lower()
    )

    # Check for required output sections (skill-specific)
    REQUIRED_SECTIONS = {
        "office-hours":     ["REFINED_SPEC", "RECOMMENDATION", "KEY_ASSUMPTION"],
        "plan-eng-review":  ["DATA_FLOW", "EDGE_CASES", "TEST_MATRIX", "BUILD_ORDER"],
        "review":           ["REVIEW_REPORT", "MULTI_TENANT_AUDIT", "VERDICT"],
        "cso":              ["OWASP_RESULTS", "STRIDE_RESULTS", "VERDICT"],
        "qa":               ["QA_REPORT", "SCENARIOS_RUN", "VERDICT"],
    }

    sections = REQUIRED_SECTIONS.get(skill_name, [])
    section_score = sum(
        1 for s in sections if s in skill_output
    ) / max(len(sections), 1)

    signals["lint_score"]    = section_score   # proxy: structured output = "linted"
    signals["test_pass_rate"] = section_score  # proxy: complete output = tests pass

    # LLM-as-judge for quality (only for GRPO eval — not in production loop)
    quality_score = await llm_judge_quality(skill_output, task, skill_name)
    signals["user_accept"] = quality_score

    # deploy_success and canary_clean are 0 for synthetic tasks
    # (no actual deployment happens)
    signals["deploy_success"] = 0.0
    signals["canary_clean"]   = 0.0

    return signals


async def llm_judge_quality(output: str, task: str, skill_name: str) -> float:
    """
    LLM-as-judge: score skill output quality 0-1
    Uses Groq free tier (cheap, fast enough for eval)
    """
    prompt = f"""You are evaluating the output of a {skill_name} agent.
Task given to agent: {task}
Agent output: {output[:2000]}

Score the output quality from 0.0 to 1.0 where:
1.0 = perfect: complete, actionable, addresses the task fully
0.5 = partial: covers main points but missing key elements
0.0 = poor: incomplete, off-task, or wrong format

Respond with ONLY a number between 0.0 and 1.0. Nothing else."""

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"{GROQ_BASE_URL}/chat/completions",
            json={
                "model": "llama-3.3-70b-versatile",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 10,
                "temperature": 0,
            },
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        )
        text = res.json()["choices"][0]["message"]["content"].strip()
        try:
            score = float(text)
            return max(0.0, min(1.0, score))
        except ValueError:
            return 0.5   # neutral on parse failure


# ─── Qdrant helpers ────────────────────────────────────────────────────────────

async def fetch_skill_variants(
    client: QdrantClient,
    skill_name: str,
    n: int = 4,
) -> list[SkillVariant]:
    results = client.scroll(
        collection_name=QDRANT_COLLECTION,
        scroll_filter=Filter(
            must=[
                FieldCondition(key="skill_name", match=MatchValue(value=skill_name)),
                FieldCondition(key="deprecated", match=MatchValue(value=False)),
            ]
        ),
        limit=n,
        with_payload=True,
        with_vectors=False,
    )

    variants = []
    for point in results[0]:
        p = point.payload
        variants.append(SkillVariant(
            variant_id=point.id,
            skill_name=p["skill_name"],
            prompt_text=p["prompt_text"],
            reward_history=p.get("reward_history", []),
            eval_count=p.get("eval_count", 0),
            active=p.get("active", False),
            strike_count=p.get("strike_count", 0),
            source_repo=p.get("source_repo"),
        ))

    return variants


# ─── Entry point for CF Queue consumer ────────────────────────────────────────

async def handle_grpo_queue_message(message: dict) -> None:
    """Called by CF Worker Queue consumer when grpo-eval message received"""
    skill_name = message["skill_name"]
    trigger_sprint = message["trigger_sprint"]

    result = await run_grpo_eval(skill_name, trigger_sprint)

    # Write result to PostgreSQL for audit trail
    await write_eval_result(result)

    print(f"[GRPO] Done: {json.dumps(result, indent=2)}")


if __name__ == "__main__":
    # Manual trigger for testing
    import sys
    skill = sys.argv[1] if len(sys.argv) > 1 else "review"
    asyncio.run(run_grpo_eval(skill, "manual-test"))

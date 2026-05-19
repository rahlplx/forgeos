/**
 * ForgeOS Trigger Map
 * CF Worker edge function — routes sprint events to skill jobs
 * All events hit POST /trigger/{event_type} with {sprint_id, project_id, payload}
 */

import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workers'

// ─── Event → Skill routing map ────────────────────────────────────────────────

export const TRIGGER_MAP = {

  // ── Sprint lifecycle ──────────────────────────────────────────────────────
  'sprint.created': {
    skill: 'office-hours',
    mode: 'sequential',
    next_on_pass: 'plan.approved',
    next_on_fail: 'sprint.hold',
    human_gate: false,
  },

  'plan.approved': {
    skill: 'autoplan',                      // orchestrates fork-join below
    mode: 'fork-join',
    parallel: ['plan-ceo-review', 'plan-eng-review', 'plan-design-review'],
    fan_in: 'all-pass',                     // all three must pass to continue
    next_on_pass: 'human.plan_gate',        // CEO scope decisions surfaced to UI
    next_on_fail: 'sprint.replan',
    human_gate: true,                       // waitForEvent('plan-approve')
  },

  'human.plan_approved': {
    skill: null,                            // direct to sandbox build
    mode: 'sequential',
    next_on_pass: 'sandbox.build',
    human_gate: false,
  },

  // ── Build phase ───────────────────────────────────────────────────────────
  'sandbox.build': {
    skill: null,                            // sandbox coordinator handles this
    mode: 'sandbox_exec',
    executor: 'sandbox-coordinator',        // Oracle ARM or CF Sandbox
    signals_on_complete: ['build.exit_code', 'build.duration_secs'],
    next_on_pass: 'sandbox.test',
    next_on_fail: 'build.failed',
  },

  'sandbox.test': {
    skill: null,
    mode: 'sandbox_exec',
    executor: 'sandbox-coordinator',
    signals_on_complete: ['test.pass_rate', 'test.duration_secs', 'coverage.pct'],
    next_on_pass: 'review.trigger',
    next_on_fail: 'test.failed',
  },

  // ── Review phase ──────────────────────────────────────────────────────────
  'review.trigger': {
    skill: 'review',
    mode: 'sequential',
    next_on_pass: 'review.passed',
    next_on_fail: 'review.escalated',
    human_gate: false,
  },

  'review.passed': {
    skill: null,
    mode: 'fork-join',
    parallel: ['qa', 'cso'],               // QA and CSO run simultaneously
    fan_in: 'all-pass',
    next_on_pass: 'human.pr_gate',
    next_on_fail: 'review.failed',
    human_gate: true,                      // waitForEvent('pr-approve')
  },

  // ── Ship phase ────────────────────────────────────────────────────────────
  'human.pr_approved': {
    skill: 'ship',
    mode: 'sequential',
    next_on_pass: 'deploy.complete',
    next_on_fail: 'ship.aborted',
    human_gate: false,
  },

  'deploy.complete': {
    skill: null,
    mode: 'fork-join',
    parallel: ['canary', 'benchmark'],
    fan_in: 'any-pass',                    // canary pass is enough to complete
    next_on_pass: 'sprint.complete',
    next_on_fail: 'deploy.rollback',
    human_gate: false,
  },

  // ── Async / scheduled ─────────────────────────────────────────────────────
  'schedule.weekly': {
    skill: 'retro',
    mode: 'sequential',
    scope: 'global',                       // runs across all projects
    trigger_type: 'cron',
    cron: '0 9 * * MON',                  // Monday 9am
    human_gate: false,
  },

  'sprint.complete': {
    skill: 'learn',
    mode: 'sequential',
    trigger_type: 'event',
    human_gate: false,
  },

  'commit.pushed': {
    skill: 'learn',
    mode: 'sequential',
    trigger_type: 'webhook',
    webhook_source: 'github',
    human_gate: false,
  },

} satisfies Record<string, TriggerConfig>


// ─── CF Workflow: Sprint DAG ───────────────────────────────────────────────────

export class SprintWorkflow extends WorkflowEntrypoint {

  async run(event: WorkflowEvent<SprintPayload>, step: WorkflowStep) {

    const { sprint_id, project_id, spec } = event.payload

    // ── Step 1: Office Hours ──────────────────────────────────────────────
    const officeHours = await step.do('office-hours', async () => {
      return await callSkill('office-hours', { sprint_id, project_id, spec })
    })

    if (officeHours.trivial) {
      // Skip planning — trivial sprint goes direct to build
      return await step.do('trivial-build', async () => {
        return await callSandbox({ sprint_id, project_id, spec })
      })
    }

    // ── Step 2: Parallel planning (CEO + Eng + Design) ────────────────────
    const [ceoReview, engReview] = await Promise.all([
      step.do('plan-ceo-review', async () =>
        callSkill('plan-ceo-review', { sprint_id, project_id,
          refined_spec: officeHours.refined_spec })
      ),
      step.do('plan-eng-review', async () =>
        callSkill('plan-eng-review', { sprint_id, project_id,
          refined_spec: officeHours.refined_spec })
      ),
    ])

    // ── Step 3: Human plan gate (sleeps until UI event) ───────────────────
    const planApproval = await step.waitForEvent('plan-approve', {
      timeout: '7 days',                   // abandon sprint after 7 days
    })

    if (planApproval.action === 'reject') {
      return { status: 'rejected', reason: planApproval.reason }
    }

    // ── Step 4: Sandbox build + test ──────────────────────────────────────
    const buildResult = await step.do('sandbox-build', {
      retries: { limit: 3, delay: '30 seconds', backoff: 'linear' },
    }, async () => {
      return await callSandbox({
        sprint_id, project_id,
        build_plan: engReview.build_order,
      })
    })

    // ── Step 5: Code review ───────────────────────────────────────────────
    const review = await step.do('review', async () =>
      callSkill('review', { sprint_id, project_id, diff: buildResult.diff })
    )

    if (review.verdict === 'ESCALATE') {
      await notifyHuman(project_id, 'review-escalation', review)
      return { status: 'escalated', reason: review.escalate_reason }
    }

    // ── Step 6: QA + CSO parallel ─────────────────────────────────────────
    const [qa, cso] = await Promise.all([
      step.do('qa', async () =>
        callSkill('qa', { sprint_id, project_id, preview_url: buildResult.preview_url })
      ),
      step.do('cso', async () =>
        callSkill('cso', { sprint_id, project_id, diff: buildResult.diff })
      ),
    ])

    // ── Step 7: PR approval gate ──────────────────────────────────────────
    await notifyHuman(project_id, 'pr-ready', { qa, cso, diff: buildResult.diff })

    const prApproval = await step.waitForEvent('pr-approve', {
      timeout: '7 days',
    })

    if (prApproval.action === 'reject') {
      return { status: 'rejected', reason: prApproval.reason }
    }

    // ── Step 8: Ship ──────────────────────────────────────────────────────
    const shipResult = await step.do('ship', {
      retries: { limit: 2, delay: '60 seconds', backoff: 'constant' },
    }, async () =>
      callSkill('ship', { sprint_id, project_id })
    )

    // ── Step 9: Canary monitoring ─────────────────────────────────────────
    await step.do('canary', async () =>
      callSkill('canary', {
        sprint_id, project_id,
        production_url: shipResult.production_url,
        monitor_mins: 30,
      })
    )

    // ── Step 10: Collect signals → RL ────────────────────────────────────
    await step.do('signal-collect', async () =>
      collectAndScoreSignals({ sprint_id, project_id })
    )

    return { status: 'shipped', version: shipResult.version }
  }
}

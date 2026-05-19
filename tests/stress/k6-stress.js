/**
 * ForgeOS Stress Test Suite
 * k6 load test: API layer + synthetic sprint injection + chaos scenarios
 *
 * Usage:
 *   k6 run tests/stress/k6-stress.js                    # API load only
 *   k6 run tests/stress/k6-stress.js -e SPRINTS=true    # + 15 parallel sprints
 *   k6 run tests/stress/k6-stress.js -e CHAOS=true      # + Oracle ARM kill sim
 */

import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js'

// ─── Custom metrics ───────────────────────────────────────────────────────────

const sprintCreated     = new Counter('sprints_created')
const sprintCompleted   = new Counter('sprints_completed')
const sprintFailed      = new Counter('sprints_failed')
const signalCollected   = new Counter('signals_collected')
const sandboxOOM        = new Counter('sandbox_oom_events')

const sprintDuration    = new Trend('sprint_duration_ms')
const skillLatency      = new Trend('skill_latency_ms')
const apiErrorRate      = new Rate('api_error_rate')

// ─── Test configuration ───────────────────────────────────────────────────────

export const options = {
  scenarios: {

    // Scenario 1: API Gateway load (CF Workers edge)
    api_gateway: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m',  target: 10  },    // ramp up
        { duration: '3m',  target: 100 },    // sustained load
        { duration: '1m',  target: 0   },    // ramp down
      ],
      tags: { scenario: 'api_gateway' },
    },

    // Scenario 2: Parallel sprint injection (agent load)
    parallel_sprints: {
      executor: 'constant-vus',
      vus: 15,
      duration: '5m',
      startTime: '2m',                       // start after API ramp-up
      tags: { scenario: 'parallel_sprints' },
      exec: 'runParallelSprints',
    },

    // Scenario 3: Skill endpoint direct load
    skill_endpoints: {
      executor: 'constant-arrival-rate',
      rate: 50,                              // 50 skill calls per second
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 20,
      maxVUs: 50,
      startTime: '1m',
      tags: { scenario: 'skill_endpoints' },
      exec: 'hammerskillEndpoints',
    },
  },

  thresholds: {
    // API must be fast (CF Workers edge)
    http_req_duration: ['p(95)<200'],        // 95th percentile under 200ms
    'http_req_duration{endpoint:sprint_create}': ['p(99)<500'],

    // Sprint orchestration (CF Workflows) — longer acceptable
    sprint_duration_ms: ['p(95)<900000'],    // 95% under 15 minutes

    // Skill calls (LLM-backed — accept higher latency)
    skill_latency_ms: ['p(95)<30000'],       // 95% under 30s

    // Error rates
    api_error_rate: ['rate<0.01'],           // <1% error rate
    checks: ['rate>0.99'],                   // >99% checks pass
  },
}

const BASE_URL = __ENV.BASE_URL || 'https://forgeos-staging.workers.dev'
const API_KEY  = __ENV.API_KEY  || 'test-key'

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
}

// ─── Scenario: API Gateway load ───────────────────────────────────────────────

export default function () {
  group('API Gateway — core endpoints', () => {

    // Health check (should be instant from CF edge)
    group('health', () => {
      const res = http.get(`${BASE_URL}/health`, { headers: HEADERS })
      check(res, {
        'health 200': r => r.status === 200,
        'health fast': r => r.timings.duration < 50,
      })
    })

    // Project creation
    group('project_create', () => {
      const res = http.post(`${BASE_URL}/api/projects`,
        JSON.stringify({
          name: `stress-project-${randomString(8)}`,
          repo_url: 'https://github.com/test/repo',
          stack: 'sveltekit-fastapi',
        }),
        { headers: HEADERS, tags: { endpoint: 'project_create' } }
      )
      check(res, {
        'project created': r => r.status === 201,
        'has project_id': r => !!r.json('project_id'),
      })
      apiErrorRate.add(res.status >= 400)
    })

    // Sprint status polling (high frequency in production)
    group('sprint_status', () => {
      const res = http.get(
        `${BASE_URL}/api/sprints/test-sprint-id/status`,
        { headers: HEADERS, tags: { endpoint: 'sprint_status' } }
      )
      check(res, {
        'status 200 or 404': r => [200, 404].includes(r.status),
        'status fast': r => r.timings.duration < 100,
      })
    })

    // Skill score dashboard (Vectorize reads)
    group('skill_scores', () => {
      const res = http.get(
        `${BASE_URL}/api/projects/test-project/skills/scores`,
        { headers: HEADERS, tags: { endpoint: 'skill_scores' } }
      )
      check(res, {
        'scores 200': r => r.status === 200,
        'has skill array': r => Array.isArray(r.json('skills')),
      })
    })

  })

  sleep(0.1)
}

// ─── Scenario: Parallel sprint injection ──────────────────────────────────────

export function runParallelSprints() {
  group('Synthetic sprint injection', () => {
    const projectId = `stress-project-${__VU}`

    // Create sprint
    const start = Date.now()
    const createRes = http.post(`${BASE_URL}/api/sprints`,
      JSON.stringify({
        project_id: projectId,
        spec: `Add a ${randomString(5)} feature with tests and deploy`,
        synthetic: true,                   // flag: use mock LLM for stress test
      }),
      { headers: HEADERS, tags: { endpoint: 'sprint_create' } }
    )

    const ok = check(createRes, {
      'sprint created': r => r.status === 201,
      'has sprint_id': r => !!r.json('sprint_id'),
      'workflow started': r => r.json('workflow_status') === 'running',
    })

    if (!ok) {
      sprintFailed.add(1)
      return
    }

    sprintCreated.add(1)
    const sprintId = createRes.json('sprint_id')

    // Poll for completion (max 15 minutes)
    const MAX_POLLS = 90
    let polls = 0
    let status = 'running'

    while (status === 'running' && polls < MAX_POLLS) {
      sleep(10)                            // poll every 10 seconds
      polls++

      const statusRes = http.get(
        `${BASE_URL}/api/sprints/${sprintId}/status`,
        { headers: HEADERS }
      )

      if (statusRes.status === 200) {
        status = statusRes.json('status')
      }
    }

    const duration = Date.now() - start
    sprintDuration.add(duration)

    if (status === 'shipped') {
      sprintCompleted.add(1)
      check(null, {
        'sprint completed in time': () => duration < 900000,  // 15 min
      })
    } else {
      sprintFailed.add(1)
    }
  })
}

// ─── Scenario: Skill endpoint hammering ───────────────────────────────────────

const SKILLS = [
  'office-hours',
  'plan-ceo-review',
  'plan-eng-review',
  'review',
  'cso',
]

export function hammerskillEndpoints() {
  const skill = SKILLS[Math.floor(Math.random() * SKILLS.length)]
  const start = Date.now()

  const res = http.post(`${BASE_URL}/api/skills/${skill}/run`,
    JSON.stringify({
      sprint_id: `stress-${randomString(8)}`,
      project_id: 'stress-project-1',
      spec: 'Add user authentication with JWT and refresh tokens',
      synthetic: true,
    }),
    { headers: HEADERS, tags: { endpoint: 'skill_run', skill } }
  )

  skillLatency.add(Date.now() - start)

  check(res, {
    'skill accepted': r => [200, 202].includes(r.status),
    'has verdict': r => !!r.json('verdict') || r.json('queued') === true,
  })

  apiErrorRate.add(res.status >= 500)
}


// ─── Chaos test: Oracle ARM sandbox failure ───────────────────────────────────

export function setup() {
  if (__ENV.CHAOS !== 'true') return

  console.log('[CHAOS] Simulating Oracle ARM sandbox unavailability')

  // Signal sandbox coordinator to reject new jobs (simulates OOM/crash)
  http.post(`${BASE_URL}/api/admin/chaos/sandbox-kill`, null, {
    headers: { ...HEADERS, 'X-Chaos-Duration': '60' },  // 60s downtime
  })

  console.log('[CHAOS] Oracle ARM killed. Watching CF Sandbox failover...')
}

export function teardown() {
  if (__ENV.CHAOS !== 'true') return

  // Re-enable Oracle ARM
  http.post(`${BASE_URL}/api/admin/chaos/sandbox-restore`, null, {
    headers: HEADERS,
  })

  console.log('[CHAOS] Oracle ARM restored. Verifying queue drain...')
}


// ─── Assertions for stress test report ───────────────────────────────────────

export function handleSummary(data) {
  const passed = data.metrics.checks.values.rate > 0.99
  const p95api = data.metrics.http_req_duration.values['p(95)']
  const errorRate = data.metrics.api_error_rate?.values?.rate ?? 0

  const report = {
    timestamp: new Date().toISOString(),
    passed,
    summary: {
      api_p95_ms: p95api,
      error_rate_pct: (errorRate * 100).toFixed(2),
      sprints_created: data.metrics.sprints_created?.values?.count ?? 0,
      sprints_completed: data.metrics.sprints_completed?.values?.count ?? 0,
      sprints_failed: data.metrics.sprints_failed?.values?.count ?? 0,
      skill_p95_ms: data.metrics.skill_latency_ms?.values['p(95)'] ?? 0,
    },
    verdict: passed ? 'STRESS_PASS' : 'STRESS_FAIL',
  }

  // Write to file for CI integration
  return {
    'tests/stress/results/latest.json': JSON.stringify(report, null, 2),
    stdout: `\n${report.verdict}: ${JSON.stringify(report.summary, null, 2)}\n`,
  }
}

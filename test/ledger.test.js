'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  API_MAX_BUFFER,
  API_TIMEOUT_MS,
  LedgerError,
  PAGE_SIZE,
  collectSnapshot,
  intervalSeconds,
  makeReport,
  main,
  markdownText,
  projectSnapshot,
  renderMarkdown,
  renderText,
  repositoryFromRemote,
  requestGitHub,
} = require('../lib/ledger');

const ROOT = path.resolve(__dirname, '..');
const SHA = 'ab'.repeat(20);
const COLLECTED = '2026-10-03T00:00:00Z';

function at(second, fraction = 0) {
  const ms = second * 1000 + fraction;
  return new Date(Date.parse('2026-10-01T00:00:00Z') + ms).toISOString();
}

function step(number, name, startedAt, completedAt, conclusion = 'success', status = 'completed') {
  return { number, name, status, conclusion, started_at: startedAt, completed_at: completedAt };
}

function job(id, name, start, duration, options = {}) {
  const startedAt = options.started_at !== undefined ? options.started_at : at(start);
  const completedAt = options.completed_at !== undefined ? options.completed_at : duration === null ? null : at(start + duration);
  const row = {
    id,
    run_id: options.run_id || 7001,
    name,
    status: options.status || 'completed', conclusion: options.conclusion || 'success',
    started_at: startedAt,
    completed_at: completedAt,
    labels: options.labels || ['ubuntu-latest'],
    steps: options.steps || [step(1, `${name} step`, startedAt, completedAt, options.stepConclusion || 'success')],
  };
  if (options.owner !== 'absent') row.run_attempt = options.owner ?? 1;
  if (options.head_sha !== undefined) row.head_sha = options.head_sha;
  return row;
}

function metadata(runId, workflowId, headSha, attempt, conclusion, extras = {}) {
  return {
    id: runId,
    workflow_id: workflowId,
    head_sha: headSha,
    run_attempt: attempt,
    status: 'completed', conclusion,
    name: extras.name || 'Build',
    head_branch: extras.branch || 'main',
    run_number: extras.run_number || 41,
  };
}

function pagesFor(attempt, jobs) {
  const count = Math.max(1, Math.ceil(jobs.length / PAGE_SIZE));
  const pages = [];
  for (let page = 1; page <= count; page += 1) {
    const rows = jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    pages.push({ page, per_page: PAGE_SIZE, total_count: jobs.length, fetched_at: COLLECTED, jobs: rows });
  }
  return pages;
}

function makeSnapshot(attemptSpecs, options = {}) {
  const runId = options.runId || 7001;
  const workflowId = options.workflowId || 31;
  const headSha = options.headSha || SHA;
  const name = options.workflowName || 'Build';
  const last = attemptSpecs.at(-1);
  const parent = metadata(runId, workflowId, headSha, attemptSpecs.length, last.conclusion, { name });
  return {
    schema_version: 1,
    repository: options.repository || 'example/project',
    sample_kind: 'live_api',
    collected_at: COLLECTED,
    limit: options.limit || 20,
    run_list_total_count: options.runListTotal ?? 1,
    runs: [{
      excluded: false,
      initial_parent: { observed_at: COLLECTED, metadata: parent },
      final_parent: { observed_at: COLLECTED, metadata: parent },
      attempts: attemptSpecs.map((spec, index) => ({
        number: spec.number || index + 1,
        requested_at: COLLECTED,
        fetched_at: COLLECTED,
        metadata: metadata(runId, workflowId, headSha, spec.number || index + 1, spec.conclusion, { name }),
        pages: spec.pages || pagesFor(spec.number || index + 1, (spec.jobs || []).map((item) => ({ run_id: runId, head_sha: headSha, ...item }))),
      })),
    }],
  };
}

function demo() {
  return structuredClone(require('../fixtures/demo-snapshot.json'));
}

function oneSecondJob(id, attempt = 1, runId = 8001) {
  return job(id, `job-${id}`, id, 1, { owner: attempt, run_id: runId });
}

function makeApiFixture(runId, jobsByAttempt, options = {}) {
  const workflowId = options.workflowId || 41;
  const headSha = options.headSha || SHA;
  const latestAttempt = options.latestAttempt || jobsByAttempt.length;
  const latestConclusion = options.latestConclusion || 'success';
  const run = metadata(runId, workflowId, headSha, latestAttempt, latestConclusion, { name: 'API workflow' });
  const requestLog = [];
  let runRead = 0;
  const request = async (endpoint) => {
    requestLog.push(endpoint);
    if (endpoint.includes('/actions/runs?')) return { total_count: 1, workflow_runs: [run] };
    if (endpoint.endsWith(`/actions/runs/${runId}`)) {
      runRead += 1;
      if (options.finalParent) return options.finalParent;
      return run;
    }
    const attemptMatch = endpoint.match(new RegExp(`/actions/runs/${runId}/attempts/(\\d+)(?:/jobs)?(?:\\?|$)`));
    if (!attemptMatch) throw new Error(`unexpected request ${endpoint}`);
    const attemptNumber = Number(attemptMatch[1]);
    if (endpoint.includes('/jobs?')) {
      if (options.failEndpoint === endpoint) throw new Error('token=do-not-print');
      const all = jobsByAttempt[attemptNumber - 1] || [];
      const pageMatch = endpoint.match(/[?&]page=(\d+)/);
      const page = Number(pageMatch?.[1] || 1);
      const total = options.changedPageTotal && page > 1 ? all.length + 1 : all.length;
      return { total_count: total, jobs: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
    }
    const spec = options.attemptMetadata?.[attemptNumber - 1];
    return spec || metadata(runId, workflowId, headSha, attemptNumber, options.conclusions?.[attemptNumber - 1] || (attemptNumber === latestAttempt ? latestConclusion : 'failure'), { name: 'API workflow' });
  };
  return { request, requestLog, get runRead() { return runRead; }, run };
}

test('demo control reports exact attempt seconds and explicit carried rows', () => {
  const report = makeReport(demo());
  assert.equal(report.coverage.unique_jobs, 5);
  assert.equal(report.coverage.job_views, 7);
  assert.equal(report.coverage.reused_job_views, 2);
  assert.equal(report.coverage.job_seconds, 265);
  assert.deepEqual(report.attempt_ledger.map((row) => [row.attempt, row.job_seconds, row.failed_before_pass_seconds]), [[1, 163, 163], [2, 102, 0]]);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 163);
  assert.equal(report.retry_breakdown.later_success_attempt_seconds, 102);
  assert.ok(report.attempt_ledger.every((row) => row.source_url.includes('/attempts/')));
  assert.ok(report.job_ledger.every((row) => row.source_url.includes('/job/')));
});

test('intervals preserve exact milliseconds and reject missing or reversed endpoints', () => {
  assert.equal(intervalSeconds('2026-10-01T00:00:00.250Z', '2026-10-01T00:00:01.500Z'), 1.25);
  assert.equal(intervalSeconds('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'), 0);
  assert.equal(intervalSeconds(null, at(1)), null);
  assert.equal(intervalSeconds(at(2), 'not-a-date'), null);
  assert.equal(intervalSeconds(at(3), at(2)), null);
});

test('parallel job intervals sum and workflow IDs separate same-named workflows', () => {
  const first = job(11, 'compile', 0, 11, { run_id: 8101, owner: 1, labels: ['z-runner', 'a-runner'] });
  const second = job(12, 'compile', 0, 28, { run_id: 8102, owner: 1, labels: ['a-runner', 'z-runner'] });
  const one = makeSnapshot([{ conclusion: 'success', jobs: [first] }], { runId: 8101, workflowId: 31, workflowName: 'same name' });
  const two = makeSnapshot([{ conclusion: 'success', jobs: [second] }], { runId: 8102, workflowId: 32, workflowName: 'same name' });
  const report = makeReport({ ...one, run_list_total_count: 2, runs: [...one.runs, ...two.runs] });
  assert.equal(report.coverage.job_seconds, 39);
  assert.deepEqual(report.rankings.workflows.map((row) => row.workflow_id), [32, 31]);
  assert.deepEqual(report.rankings.runners[0].labels, ['a-runner', 'z-runner']);
});

test('partial rerun counts carried jobs once and includes successful parallel jobs in the failed attempt', () => {
  const success = job(21, 'S', 0, 70, { run_id: 8201, owner: 1 });
  const failure = job(22, 'F', 70, 30, { run_id: 8201, owner: 1, conclusion: 'failure' });
  const carried = structuredClone(success);
  const fresh = job(23, 'T', 110, 20, { run_id: 8201, owner: 2 });
  const report = makeReport(makeSnapshot([
    { conclusion: 'failure', jobs: [success, failure] },
    { conclusion: 'success', jobs: [carried, fresh] },
  ], { runId: 8201 }));
  assert.deepEqual(report.attempt_ledger.map((row) => row.job_seconds), [100, 20]);
  assert.deepEqual(report.attempt_ledger.map((row) => row.reused_job_count), [0, 1]);
  assert.equal(report.coverage.job_seconds, 120);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 100);
  assert.equal(report.coverage.measured_steps, 3);
});

test('attempt pages with only newly executed jobs retain totals without inferred carries', () => {
  const success = job(31, 'S', 0, 70, { run_id: 8301, owner: 1 });
  const failure = job(32, 'F', 70, 30, { run_id: 8301, owner: 1, conclusion: 'failure' });
  const fresh = job(33, 'T', 110, 20, { run_id: 8301, owner: 2 });
  const report = makeReport(makeSnapshot([
    { conclusion: 'failure', jobs: [success, failure] },
    { conclusion: 'success', jobs: [fresh] },
  ], { runId: 8301 }));
  assert.equal(report.coverage.job_seconds, 120);
  assert.equal(report.attempt_ledger[1].reused_job_count, 0);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 100);
});

test('same-name jobs with distinct IDs represent distinct executions', () => {
  const first = job(41, 'Test', 0, 100, { run_id: 8401, owner: 1, conclusion: 'failure' });
  const rerun = job(42, 'Test', 100, 60, { run_id: 8401, owner: 2 });
  const report = makeReport(makeSnapshot([
    { conclusion: 'failure', jobs: [first] },
    { conclusion: 'success', jobs: [rerun] },
  ], { runId: 8401 }));
  assert.equal(report.coverage.job_seconds, 160);
  assert.equal(report.coverage.unique_jobs, 2);
  assert.equal(report.coverage.reused_job_views, 0);
  assert.equal(report.rankings.jobs[0].executions, 2);
});

test('unordered attempt records are ordered numerically and repeated carried jobs add no time', () => {
  const s = job(51, 'S', 0, 70, { run_id: 8501, owner: 1 });
  const f = job(52, 'F', 70, 30, { run_id: 8501, owner: 1, conclusion: 'failure' });
  const t = job(53, 'T', 110, 20, { run_id: 8501, owner: 2 });
  const u = job(54, 'U', 140, 5, { run_id: 8501, owner: 3 });
  const input = makeSnapshot([
    { conclusion: 'failure', jobs: [s, f] },
    { conclusion: 'success', jobs: [structuredClone(s), t] },
    { conclusion: 'success', jobs: [structuredClone(s), structuredClone(t), u] },
  ], { runId: 8501 });
  input.runs[0].attempts.reverse();
  const report = makeReport(input);
  assert.deepEqual(report.attempt_ledger.map((row) => row.attempt), [1, 2, 3]);
  assert.deepEqual(report.attempt_ledger.map((row) => row.reused_job_count), [0, 1, 2]);
  assert.deepEqual(report.attempt_ledger.map((row) => row.job_seconds), [100, 20, 5]);
  assert.equal(report.coverage.job_seconds, 125);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 100);
});

test('skipped, missing, malformed, reversed, zero, and valid intervals keep separate coverage', () => {
  const rows = [
    job(61, 'fifteen', 0, 15, { run_id: 8601 }),
    job(62, 'missing', 0, null, { run_id: 8601, started_at: null, completed_at: at(1) }),
    job(63, 'malformed', 0, null, { run_id: 8601, started_at: at(0), completed_at: 'bad timestamp' }),
    job(64, 'reversed', 2, null, { run_id: 8601, started_at: at(2), completed_at: at(1) }),
    job(65, 'zero', 3, 0, { run_id: 8601 }),
    job(66, 'skipped timed', 4, 15, { run_id: 8601, conclusion: 'skipped' }),
    job(67, 'skipped missing', 5, null, { run_id: 8601, conclusion: 'skipped', started_at: null, completed_at: null }),
  ];
  const report = makeReport(makeSnapshot([{ conclusion: 'success', jobs: rows }], { runId: 8601 }));
  assert.equal(report.coverage.job_seconds, 15);
  assert.equal(report.coverage.measured_jobs, 2);
  assert.equal(report.coverage.unmeasured_jobs, 3);
  assert.equal(report.coverage.skipped_jobs, 2);
  assert.equal(report.coverage.duration_complete, false);
  assert.deepEqual(report.rankings.jobs.filter((row) => row.name === 'zero'), []);
  assert.ok(report.warnings.some((warning) => warning.includes('3 job(s)')));
});

test('failed, timed out, startup failure, cancelled, and neutral categories are distinct', () => {
  const specs = [
    ['failure', 30],
    ['timed_out', 40],
    ['success', 20],
    ['success', 10],
    ['cancelled', 25],
  ];
  const rows = specs.map(([attemptConclusion, seconds], index) => ({
    jobs: [job(70 + index, `job-${index}`, index * 100, seconds, { run_id: 8701, owner: index + 1, conclusion: 'success' })], conclusion: attemptConclusion,
  }));
  const report = makeReport(makeSnapshot(rows, { runId: 8701 }));
  assert.equal(report.coverage.job_seconds, 125);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 70);
  assert.equal(report.rankings.cancelled_attempts[0].cancelled_seconds, 25);

  const zeroCancel = makeReport(makeSnapshot([
    { conclusion: 'cancelled', jobs: [job(95, 'zero-cancel', 0, 0, { run_id: 8704, owner: 1 })] },
  ], { runId: 8704 }));
  assert.equal(zeroCancel.attempt_ledger[0].cancelled_seconds, 0);
  assert.deepEqual(zeroCancel.rankings.cancelled_attempts, []);

  const neutral = makeReport(makeSnapshot([
    { conclusion: 'action_required', jobs: [job(90, 'gate', 0, 7, { run_id: 8702, owner: 1 })] },
    { conclusion: 'success', jobs: [job(91, 'after gate', 10, 9, { run_id: 8702, owner: 2 })] },
  ], { runId: 8702 }));
  assert.equal(neutral.attempt_ledger[0].job_seconds, 7);
  assert.equal(neutral.retry_breakdown.failed_attempt_seconds, 0);
  assert.equal(neutral.retry_breakdown.runs, 0);

  const noRetry = makeReport(makeSnapshot([
    { conclusion: 'success', jobs: [job(92, 'pass', 0, 70, { run_id: 8703, owner: 1 })] },
    { conclusion: 'failure', jobs: [job(93, 'later failure', 80, 30, { run_id: 8703, owner: 2 })] },
  ], { runId: 8703 }));
  assert.equal(noRetry.retry_breakdown.failed_attempt_seconds, 0);
});

test('independent runs on the same SHA do not count as retries', () => {
  const failed = makeSnapshot([{ conclusion: 'failure', jobs: [job(101, 'Build', 0, 30, { run_id: 8801 })] }], { runId: 8801 });
  const passed = makeSnapshot([{ conclusion: 'success', jobs: [job(102, 'Build', 50, 20, { run_id: 8802 })] }], { runId: 8802 });
  const report = makeReport({ ...failed, run_list_total_count: 2, runs: [...failed.runs, ...passed.runs] });
  assert.equal(report.coverage.job_seconds, 50);
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 0);
  assert.equal(report.retry_breakdown.runs, 0);
  const collision = structuredClone(passed);
  collision.runs[0].attempts[0].pages[0].jobs[0].id = 101;
  assert.throws(() => makeReport({ ...failed, run_list_total_count: 2, runs: [...failed.runs, ...collision.runs] }), /two different run IDs/);
});

test('contradictory repeated job metadata is rejected', () => {
  const base = makeSnapshot([
    { conclusion: 'failure', jobs: [job(111, 'Carry', 0, 70, { run_id: 8901, owner: 1 })] },
    { conclusion: 'success', jobs: [job(112, 'Fresh', 80, 20, { run_id: 8901, owner: 2 })] },
  ], { runId: 8901 });
  const changes = [
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].name = 'Renamed'; },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].run_attempt = 2; },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].conclusion = 'failure'; },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].started_at = at(1); },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].labels = ['macos-15']; },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].steps[0].completed_at = at(9); },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].head_sha = 'cd'.repeat(20); },
    (copy) => { copy.runs[0].attempts[1].pages[0].jobs[0].run_id = 999; },
  ];
  for (const change of changes) {
    const copy = structuredClone(base);
    const carried = structuredClone(copy.runs[0].attempts[0].pages[0].jobs[0]);
    copy.runs[0].attempts[1].pages[0].jobs.unshift(carried);
    copy.runs[0].attempts[1].pages[0].total_count += 1;
    change(copy);
    assert.throws(() => makeReport(copy));
  }
});

test('missing owner metadata is inferred but an absent earlier record cannot imply an earlier owner', () => {
  const first = job(121, 'Carry', 0, 40, { run_id: 9001, owner: 'absent' });
  const later = structuredClone(first);
  later.run_attempt = 1;
  const inferred = makeReport(makeSnapshot([
    { conclusion: 'failure', jobs: [first] },
    { conclusion: 'success', jobs: [later] },
  ], { runId: 9001 }));
  assert.equal(inferred.job_ledger[0].ownership, 'inferred');
  assert.equal(inferred.coverage.inferred_owners, 1);
  assert.equal(inferred.coverage.reused_job_views, 1);
  const invalid = makeSnapshot([
    { conclusion: 'failure', jobs: [] },
    { conclusion: 'success', jobs: [job(122, 'Late', 10, 5, { run_id: 9002, owner: 1 })] },
  ], { runId: 9002 });
  assert.throws(() => makeReport(invalid), /first observed attempt/);
});

test('snapshot validator rejects missing nested objects, duplicate IDs, and pagination gaps', () => {
  assert.throws(() => projectSnapshot(null), /must be an object/);
  const nested = demo();
  nested.runs = [null];
  assert.throws(() => projectSnapshot(nested), /must be an object/);
  const duplicateAttempt = structuredClone(demo());
  duplicateAttempt.runs[0].attempts[1].number = 1;
  assert.throws(() => projectSnapshot(duplicateAttempt), /duplicate or unexpected attempt/);
  const missingPage = structuredClone(demo());
  missingPage.runs[0].attempts[0].pages[0].total_count = 101;
  assert.throws(() => projectSnapshot(missingPage), /pagination is incomplete/);
  const duplicateJob = structuredClone(demo());
  duplicateJob.runs[0].attempts[0].pages[0].jobs[1].id = duplicateJob.runs[0].attempts[0].pages[0].jobs[0].id;
  assert.throws(() => projectSnapshot(duplicateJob), /repeats a job ID/);
  const missingRunAttempt = structuredClone(demo());
  delete missingRunAttempt.runs[0].initial_parent.metadata.run_attempt;
  assert.throws(() => projectSnapshot(missingRunAttempt), /positive safe integer/);
  const missingAttemptTime = structuredClone(demo());
  delete missingAttemptTime.runs[0].attempts[0].fetched_at;
  assert.throws(() => projectSnapshot(missingAttemptTime), /fetched_at/);
});

test('attempt cap records an exclusion and leaves collection coverage incomplete', () => {
  const parent = metadata(9201, 31, SHA, 21, 'success');
  const input = {
    schema_version: 1,
    repository: 'example/project',
    sample_kind: 'live_api',
    collected_at: COLLECTED,
    limit: 20,
    run_list_total_count: 1,
    runs: [{
      excluded: true,
      excluded_reason: 'attempt_limit_exceeded',
      initial_parent: { observed_at: COLLECTED, metadata: parent },
      final_parent: { observed_at: COLLECTED, metadata: parent },
      attempts: [],
    }],
  };
  const report = makeReport(input);
  assert.equal(report.coverage.excluded_runs, 1);
  assert.equal(report.coverage.collection_complete, false);
  assert.equal(report.coverage.job_seconds, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('above 20 attempts')));
});

test('101 jobs paginate as 100 and 1 with exact elapsed seconds', async () => {
  const jobs = Array.from({ length: 101 }, (_, index) => oneSecondJob(2000 + index, 1, 9301));
  const fixture = makeApiFixture(9301, [jobs]);
  const snapshot = await collectSnapshot('owner/repo', 1, { request: fixture.request, now: () => COLLECTED });
  const report = makeReport(snapshot);
  assert.equal(report.coverage.job_seconds, 101);
  assert.equal(report.coverage.unique_jobs, 101);
  assert.equal(report.coverage.page_count, 2);
  assert.equal(typeof snapshot.runs[0].attempts[0].requested_at, 'string');
  assert.equal(typeof snapshot.runs[0].attempts[0].fetched_at, 'string');
  assert.ok(fixture.requestLog.includes('/repos/owner/repo/actions/runs/9301/attempts/1/jobs?per_page=100&page=1'));
  assert.ok(fixture.requestLog.includes('/repos/owner/repo/actions/runs/9301/attempts/1/jobs?per_page=100&page=2'));
  assert.equal(fixture.runRead, 1);
});

test('pagination failure and changed page totals fail without returning a clean report', async () => {
  const jobs = Array.from({ length: 101 }, (_, index) => oneSecondJob(3000 + index, 1, 9401));
  const failFixture = makeApiFixture(9401, [jobs], { failEndpoint: '/repos/owner/repo/actions/runs/9401/attempts/1/jobs?per_page=100&page=2' });
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: failFixture.request, now: () => COLLECTED }), (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.message.includes('do-not-print'), false);
    return true;
  });
  const changedFixture = makeApiFixture(9402, [jobs.map((row) => ({ ...row, run_id: 9402 }))], { changedPageTotal: true });
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: changedFixture.request, now: () => COLLECTED }), /total_count changed/);
});

test('parent metadata changes during collection reject the snapshot', async () => {
  const original = metadata(9501, 41, SHA, 1, 'success');
  const changed = metadata(9501, 41, SHA, 2, 'success');
  const fixture = makeApiFixture(9501, [[]], { finalParent: changed });
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: fixture.request, now: () => COLLECTED }), /changed while its attempt history was collected/);
  const changedStatus = { ...original, conclusion: 'failure' };
  const second = makeApiFixture(9501, [[]], { finalParent: changedStatus });
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: second.request, now: () => COLLECTED }), /changed while its attempt history was collected/);
});

test('attempt metadata and duplicate IDs within a page are validated before accounting', async () => {
  const wrongAttempt = metadata(9601, 41, SHA, 2, 'success');
  const fixture = makeApiFixture(9601, [[]], { attemptMetadata: [wrongAttempt] });
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: fixture.request, now: () => COLLECTED }), /requested attempt/);
  const repeated = job(4001, 'Repeated', 0, 1, { run_id: 9602 });
  const duplicateFixture = makeApiFixture(9602, [[repeated, structuredClone(repeated)]]);
  await assert.rejects(collectSnapshot('owner/repo', 1, { request: duplicateFixture.request, now: () => COLLECTED }), /repeated a job ID/);
});

test('GET helper sets safe bounded execFile options and never exposes stderr', async () => {
  let captured;
  const payload = { ok: true };
  const result = await requestGitHub('/repos/a/b', {
    execFileImpl(binary, args, options, callback) {
      captured = { binary, args, options };
      callback(null, JSON.stringify(payload), 'TOKEN=private');
    },
  });
  assert.deepEqual(result, payload);
  assert.equal(captured.binary, 'gh');
  assert.deepEqual(captured.args.slice(0, 5), ['api', '--method', 'GET', '--hostname', 'github.com']);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.timeout, API_TIMEOUT_MS);
  assert.equal(captured.options.maxBuffer, API_MAX_BUFFER);
  await assert.rejects(requestGitHub('/repos/a/b', {
    execFileImpl(binary, args, options, callback) {
      const error = new Error('gh output includes TOKEN=private');
      error.stderr = 'TOKEN=private';
      callback(error, '', 'TOKEN=private');
    },
  }), (error) => {
    assert.ok(error instanceof LedgerError);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('repository inference accepts GitHub origins and rejects other hosts', () => {
  assert.equal(repositoryFromRemote('https://github.com/Arthur031221/gha-rerun-ledger.git'), 'Arthur031221/gha-rerun-ledger');
  assert.equal(repositoryFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
  assert.throws(() => repositoryFromRemote('https://github.enterprise.local/owner/repo.git'), /github.com/);
  assert.throws(() => repositoryFromRemote('https://github.com/owner/repo/tree/main'), /owner\/name/);
});

test('Markdown text escapes control characters and table separators', () => {
  assert.equal(markdownText('safe | [name]\n'), 'safe \\| \\[name\\]\\u{A}');
  const hostile = structuredClone(demo());
  hostile.runs[0].initial_parent.metadata.name = 'Build | [copy]\u001b';
  hostile.runs[0].final_parent.metadata.name = 'Build | [copy]\u001b';
  hostile.runs[0].attempts.forEach((attempt) => { attempt.metadata.name = 'Build | [copy]\u001b'; });
  const report = makeReport(hostile);
  const text = renderText(report);
  const markdown = renderMarkdown(report);
  assert.equal(/[^\x0a\x20-\x7e]/.test(text), false);
  assert.ok(text.includes('Build | [copy]\\x1B'));
  assert.ok(markdown.includes('Build \\| \\[copy\\]\\u{1B}'));
});

test('CLI demo runs without gh or credentials and emits the labeled real fixture report', () => {
  const env = {
    PATH: '/path/with/no-gh',
    NO_COLOR: '1',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  const result = spawnSync(process.execPath, ['bin/gha-rerun-ledger.js', '--demo', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sample_kind, 'synthetic_demo');
  assert.equal(report.retry_breakdown.failed_attempt_seconds, 163);
  assert.equal(report.retry_breakdown.later_success_attempt_seconds, 102);
});

test('real CLI text is ASCII and Markdown report has ledger links', () => {
  const report = makeReport(demo());
  const text = renderText(report);
  const markdown = renderMarkdown(report);
  assert.equal(/[^\x00-\x7f]/.test(text), false);
  assert.ok(text.includes('RETRY TIME SPLIT'));
  assert.ok(markdown.includes('actions/runs/9001/attempts/1'));
  assert.ok(markdown.includes('It does not estimate time or money saved.'));
});

test('incomplete run lists fail while an empty repository remains a valid control', async () => {
  for (const total of [1, 30]) {
    await assert.rejects(collectSnapshot('owner/repo', 20, {
      request: async () => ({ total_count: total, workflow_runs: [] }),
    }), /run-list row count is incomplete/);
  }
  const empty = await collectSnapshot('owner/repo', 20, {
    request: async () => ({ total_count: 0, workflow_runs: [] }),
  });
  assert.equal(makeReport(empty).coverage.sampled_runs, 0);
  const truncated = demo();
  truncated.runs = [];
  assert.throws(() => makeReport(truncated), /run-list row count is incomplete/);
});

test('invalid calendar dates are unmeasured without rejecting valid leap days or offsets', () => {
  assert.equal(intervalSeconds('2026-02-30T00:00:00Z', '2026-03-02T00:00:01Z'), null);
  assert.equal(intervalSeconds('2026-02-29T00:00:00Z', '2026-03-01T00:00:01Z'), null);
  assert.equal(intervalSeconds('2026-01-01T24:00:00Z', '2026-01-02T00:00:01Z'), null);
  assert.equal(intervalSeconds('2024-02-29T23:59:59Z', '2024-03-01T00:00:01Z'), 2);
  assert.equal(intervalSeconds('2026-01-01T08:00:00+08:00', '2026-01-01T00:00:02Z'), 2);
  const badSha = demo();
  badSha.runs[0].initial_parent.metadata.head_sha = 'a'.repeat(41);
  assert.throws(() => projectSnapshot(badSha), /head_sha is invalid/);
});

test('invalid carried records do not write a saved snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gha-ledger-invalid-'));
  const file = path.join(dir, 'attempts.json');
  const original = job(9401, 'shared', 0, 70, { run_id: 9400, owner: 1 });
  const conflicting = { ...original, completed_at: at(71) };
  const fixture = makeApiFixture(9400, [[original], [conflicting]], {
    conclusions: ['failure', 'success'],
  });
  try {
    await assert.rejects(main(['--repo', 'owner/repo', '--limit', '1', '--save-snapshot', file], {
      request: fixture.request,
    }), /Repeated job metadata conflicts/);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

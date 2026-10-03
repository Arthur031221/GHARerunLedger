'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCHEMA_VERSION = 1;
const ATTEMPT_LIMIT = 20;
const PAGE_SIZE = 100;
const API_TIMEOUT_MS = 20000;
const API_MAX_BUFFER = 8 * 1024 * 1024;
const PACKAGE = require('../package.json');

class LedgerError extends Error {}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new LedgerError(`${label} must be an object.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new LedgerError(`${label} must be an array.`);
  return value;
}

function requireString(value, label, options = {}) {
  if (typeof value !== 'string' || (options.nonempty && value.trim() === '')) {
    throw new LedgerError(`${label} must be ${options.nonempty ? 'a nonempty string' : 'a string'}.`);
  }
  return value;
}

function requireNullableString(value, label) {
  if (value !== null && typeof value !== 'string') {
    throw new LedgerError(`${label} must be a string or null.`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LedgerError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LedgerError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function parseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new LedgerError('Repository must use owner/name form for github.com.');
  }
  const [owner, name] = value.split('/');
  if (!owner || !name || owner.startsWith('.') || name.startsWith('.')) {
    throw new LedgerError('Repository must use owner/name form for github.com.');
  }
  return `${owner}/${name}`;
}

function repositoryFromRemote(remote) {
  const value = String(remote || '').trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return parseRepository(`${match[1]}/${match[2]}`);
  }
  throw new LedgerError('Could not infer a github.com owner/name from remote.origin.url; pass --repo owner/name.');
}

function timestampIsValid(value) {
  if (typeof value !== 'string') return false;
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59 || Number(parts[7] || 0) > 23 || Number(parts[8] || 0) > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function requireObservationTime(value, label) {
  if (!timestampIsValid(value)) throw new LedgerError(`${label} must be an ISO timestamp with a timezone.`);
}

function projectParent(value, label) {
  const parent = requireObject(value, label);
  const out = {
    id: requirePositiveInteger(parent.id, `${label}.id`),
    workflow_id: requirePositiveInteger(parent.workflow_id, `${label}.workflow_id`),
    head_sha: requireString(parent.head_sha, `${label}.head_sha`, { nonempty: true }),
    run_attempt: requirePositiveInteger(parent.run_attempt, `${label}.run_attempt`),
    status: requireString(parent.status, `${label}.status`, { nonempty: true }), conclusion: requireString(parent.conclusion, `${label}.conclusion`, { nonempty: true }),
  };
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(out.head_sha)) throw new LedgerError(`${label}.head_sha is invalid.`);
  if (parent.name !== undefined && parent.name !== null) out.name = requireString(parent.name, `${label}.name`);
  if (parent.head_branch !== undefined && parent.head_branch !== null) out.head_branch = requireString(parent.head_branch, `${label}.head_branch`);
  if (parent.run_number !== undefined && parent.run_number !== null) out.run_number = requirePositiveInteger(parent.run_number, `${label}.run_number`);
  if (out.status !== 'completed') throw new LedgerError(`${label}.status must be completed.`);
  return out;
}

function parentFingerprint(parent) {
  return [parent.id, parent.workflow_id, parent.head_sha, parent.run_attempt, parent.status, parent.conclusion].join(':');
}

function projectStep(value, label) {
  const step = requireObject(value, label);
  const out = {
    number: requirePositiveInteger(step.number, `${label}.number`),
    name: requireString(step.name, `${label}.name`),
    status: requireString(step.status, `${label}.status`, { nonempty: true }), conclusion: step.conclusion === null ? null : requireString(step.conclusion, `${label}.conclusion`, { nonempty: true }),
    started_at: step.started_at,
    completed_at: step.completed_at,
  };
  requireNullableString(out.started_at, `${label}.started_at`);
  requireNullableString(out.completed_at, `${label}.completed_at`);
  return out;
}

function projectJob(value, label, runId, headSha) {
  const job = requireObject(value, label);
  const id = requirePositiveInteger(job.id, `${label}.id`);
  const jobRunId = requirePositiveInteger(job.run_id, `${label}.run_id`);
  if (jobRunId !== runId) throw new LedgerError(`${label}.run_id does not match its run.`);
  const name = requireString(job.name, `${label}.name`, { nonempty: true });
  const status = requireString(job.status, `${label}.status`, { nonempty: true });
  const conclusion = requireString(job.conclusion, `${label}.conclusion`, { nonempty: true });
  if (status !== 'completed') throw new LedgerError(`${label}.status is not completed in a completed-run snapshot.`);
  requireNullableString(job.started_at, `${label}.started_at`);
  requireNullableString(job.completed_at, `${label}.completed_at`);
  const labels = requireArray(job.labels, `${label}.labels`);
  labels.forEach((item, index) => requireString(item, `${label}.labels[${index}]`));
  const steps = requireArray(job.steps, `${label}.steps`).map((item, index) => projectStep(item, `${label}.steps[${index}]`));
  const stepNumbers = new Set();
  for (const step of steps) {
    if (stepNumbers.has(step.number)) throw new LedgerError(`${label}.steps contains a repeated number.`);
    stepNumbers.add(step.number);
  }
  const out = {
    id,
    run_id: jobRunId,
    name,
    status, conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    labels: [...new Set(labels)].sort(),
    steps,
  };
  if (Object.hasOwn(job, 'run_attempt')) out.run_attempt = requirePositiveInteger(job.run_attempt, `${label}.run_attempt`);
  if (Object.hasOwn(job, 'head_sha')) {
    requireNullableString(job.head_sha, `${label}.head_sha`);
    if (job.head_sha !== null && job.head_sha !== headSha) throw new LedgerError(`${label}.head_sha does not match its run.`);
    out.head_sha = job.head_sha;
  }
  return out;
}

function stableJobShape(job, ownerAttempt) {
  const steps = [...job.steps]
    .sort((left, right) => left.number - right.number)
    .map((step) => [step.number, step.name, step.status, step.conclusion, step.started_at, step.completed_at]);
  return JSON.stringify({
    id: job.id,
    run_id: job.run_id,
    run_attempt: ownerAttempt,
    head_sha: job.head_sha ?? null,
    name: job.name,
    status: job.status, conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    labels: [...job.labels].sort(),
    steps,
  });
}

function projectSnapshot(snapshot) {
  const root = requireObject(snapshot, 'Snapshot');
  if (root.schema_version !== SCHEMA_VERSION) throw new LedgerError(`Snapshot schema_version must be ${SCHEMA_VERSION}.`);
  const repository = parseRepository(root.repository);
  const sampleKind = requireString(root.sample_kind, 'Snapshot.sample_kind', { nonempty: true });
  if (!['synthetic_demo', 'live_api'].includes(sampleKind)) throw new LedgerError('Snapshot.sample_kind is unsupported.');
  requireObservationTime(root.collected_at, 'Snapshot.collected_at');
  const limit = requirePositiveInteger(root.limit, 'Snapshot.limit');
  if (limit > 100) throw new LedgerError('Snapshot.limit must be from 1 through 100.');
  const runListTotal = requireNonnegativeInteger(root.run_list_total_count, 'Snapshot.run_list_total_count');
  const runs = requireArray(root.runs, 'Snapshot.runs');
  if (runs.length > limit) throw new LedgerError('Snapshot.runs exceeds Snapshot.limit.');
  if (runs.length > runListTotal) throw new LedgerError('Snapshot.runs exceeds the workflow run query total_count.');
  if (runs.length !== Math.min(runListTotal, limit)) throw new LedgerError('Snapshot run-list row count is incomplete.');
  const runIds = new Set();
  const normalizedRuns = [];
  for (let index = 0; index < runs.length; index += 1) {
    const record = requireObject(runs[index], `Snapshot.runs[${index}]`);
    const initial = requireObject(record.initial_parent, `Snapshot.runs[${index}].initial_parent`);
    const final = requireObject(record.final_parent, `Snapshot.runs[${index}].final_parent`);
    requireObservationTime(initial.observed_at, `Snapshot.runs[${index}].initial_parent.observed_at`);
    requireObservationTime(final.observed_at, `Snapshot.runs[${index}].final_parent.observed_at`);
    const initialMeta = projectParent(initial.metadata, `Snapshot.runs[${index}].initial_parent.metadata`);
    const finalMeta = projectParent(final.metadata, `Snapshot.runs[${index}].final_parent.metadata`);
    if (parentFingerprint(initialMeta) !== parentFingerprint(finalMeta)) {
      throw new LedgerError(`Snapshot.runs[${index}] parent metadata changed during collection.`);
    }
    if (runIds.has(initialMeta.id)) throw new LedgerError('Snapshot contains a repeated run ID.');
    runIds.add(initialMeta.id);
    if (record.excluded === true) {
      if (initialMeta.run_attempt <= ATTEMPT_LIMIT) throw new LedgerError(`Snapshot.runs[${index}] has an invalid attempt-limit exclusion.`);
      if (record.excluded_reason !== 'attempt_limit_exceeded') throw new LedgerError(`Snapshot.runs[${index}].excluded_reason is invalid.`);
      if (!Array.isArray(record.attempts) || record.attempts.length !== 0) throw new LedgerError(`Snapshot.runs[${index}] excluded history must not contain attempts.`);
      normalizedRuns.push({
        excluded: true,
        excluded_reason: record.excluded_reason,
        initial_parent: { observed_at: initial.observed_at, metadata: structuredClone(initial.metadata) },
        final_parent: { observed_at: final.observed_at, metadata: structuredClone(final.metadata) },
        attempts: [],
      });
      continue;
    }
    if (record.excluded !== false) throw new LedgerError(`Snapshot.runs[${index}].excluded must be a boolean.`);
    const attemptRows = requireArray(record.attempts, `Snapshot.runs[${index}].attempts`);
    const expectedCount = initialMeta.run_attempt;
    if (expectedCount > ATTEMPT_LIMIT) throw new LedgerError(`Snapshot.runs[${index}] exceeds the attempt limit without an exclusion.`);
    if (attemptRows.length !== expectedCount) throw new LedgerError(`Snapshot.runs[${index}] does not contain its complete attempt history.`);
    const attemptNumbers = new Set();
    const attempts = [];
    for (let a = 0; a < attemptRows.length; a += 1) {
      const rawAttempt = requireObject(attemptRows[a], `Snapshot.runs[${index}].attempts[${a}]`);
      const number = requirePositiveInteger(rawAttempt.number, `Snapshot.runs[${index}].attempts[${a}].number`);
      if (number > expectedCount || attemptNumbers.has(number)) throw new LedgerError(`Snapshot.runs[${index}] has a duplicate or unexpected attempt number.`);
      attemptNumbers.add(number);
      requireObservationTime(rawAttempt.requested_at, `Snapshot.runs[${index}].attempts[${a}].requested_at`);
      requireObservationTime(rawAttempt.fetched_at, `Snapshot.runs[${index}].attempts[${a}].fetched_at`);
      const metadata = projectParent(rawAttempt.metadata, `Snapshot.runs[${index}].attempts[${a}].metadata`);
      if (metadata.run_attempt !== number) throw new LedgerError(`Snapshot.runs[${index}] attempt metadata does not match the requested number.`);
      if (metadata.id !== initialMeta.id || metadata.workflow_id !== initialMeta.workflow_id || metadata.head_sha !== initialMeta.head_sha) {
        throw new LedgerError(`Snapshot.runs[${index}] attempt metadata does not match its parent run.`);
      }
      const pagesRaw = requireArray(rawAttempt.pages, `Snapshot.runs[${index}].attempts[${a}].pages`);
      if (pagesRaw.length === 0) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} has no page evidence.`);
      const pages = [];
      let expectedTotal = null;
      let collectedRows = 0;
      const attemptJobIds = new Set();
      for (let p = 0; p < pagesRaw.length; p += 1) {
        const page = requireObject(pagesRaw[p], `Snapshot.runs[${index}].attempts[${a}].pages[${p}]`);
        if (page.page !== p + 1) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} has missing or unordered pages.`);
        if (page.per_page !== PAGE_SIZE) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} page size must be ${PAGE_SIZE}.`);
        const total = requireNonnegativeInteger(page.total_count, `Snapshot.runs[${index}].attempts[${a}].pages[${p}].total_count`);
        requireObservationTime(page.fetched_at, `Snapshot.runs[${index}].attempts[${a}].pages[${p}].fetched_at`);
        if (expectedTotal === null) expectedTotal = total;
        if (total !== expectedTotal) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} page totals changed.`);
        const expectedPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (pagesRaw.length !== expectedPages) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} pagination is incomplete.`);
        const rawJobs = requireArray(page.jobs, `Snapshot.runs[${index}].attempts[${a}].pages[${p}].jobs`);
        const expectedRows = total === 0 ? 0 : Math.min(PAGE_SIZE, total - p * PAGE_SIZE);
        if (rawJobs.length !== expectedRows) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} page row count is inconsistent.`);
        const jobIds = rawJobs.map((job, j) => projectJob(job, `Snapshot.runs[${index}].attempts[${a}].pages[${p}].jobs[${j}]`, initialMeta.id, initialMeta.head_sha).id);
        for (const jobId of jobIds) {
          if (attemptJobIds.has(jobId)) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} repeats a job ID.`);
          attemptJobIds.add(jobId);
        }
        collectedRows += rawJobs.length;
        pages.push({ page: p + 1, per_page: PAGE_SIZE, total_count: total, fetched_at: page.fetched_at, jobs: structuredClone(rawJobs) });
      }
      if (collectedRows !== expectedTotal) throw new LedgerError(`Snapshot.runs[${index}] attempt ${number} did not exhaust pagination.`);
      attempts.push({ number, requested_at: rawAttempt.requested_at, fetched_at: rawAttempt.fetched_at, metadata: structuredClone(rawAttempt.metadata), pages });
    }
    for (let number = 1; number <= expectedCount; number += 1) {
      if (!attemptNumbers.has(number)) throw new LedgerError(`Snapshot.runs[${index}] is missing attempt ${number}.`);
    }
    attempts.sort((left, right) => left.number - right.number);
    const latest = attempts.at(-1).metadata;
    if (latest.status !== finalMeta.status || latest.conclusion !== finalMeta.conclusion) {
      throw new LedgerError(`Snapshot.runs[${index}] latest attempt does not agree with the final parent read.`);
    }
    normalizedRuns.push({
      excluded: false,
      initial_parent: { observed_at: initial.observed_at, metadata: structuredClone(initial.metadata) },
      final_parent: { observed_at: final.observed_at, metadata: structuredClone(final.metadata) },
      attempts,
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    repository,
    sample_kind: sampleKind,
    collected_at: root.collected_at,
    limit,
    run_list_total_count: runListTotal,
    runs: normalizedRuns,
  };
}

function intervalSeconds(startedAt, completedAt) {
  if (!timestampIsValid(startedAt) || !timestampIsValid(completedAt)) return null;
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  return elapsedMs / 1000;
}

function isSkipped(item) {
  return item.conclusion === 'skipped' || item.status === 'skipped';
}

function workflowName(parent) {
  return parent.name || `workflow ${parent.workflow_id}`;
}

function runUrl(repository, runId) {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function attemptUrl(repository, runId, attempt) {
  return `${runUrl(repository, runId)}/attempts/${attempt}`;
}

function jobUrl(repository, runId, jobId) {
  return `${runUrl(repository, runId)}/job/${jobId}`;
}

function addCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function addToGroup(map, key, initial) {
  if (!map.has(key)) map.set(key, initial());
  return map.get(key);
}

function uniqueStrings(values) {
  return [...new Set(values)].sort();
}

function formatGroupRows(map, build) {
  return [...map.values()].map(build);
}

function makeReport(inputSnapshot) {
  const snapshot = projectSnapshot(inputSnapshot);
  const attemptLedger = [];
  const jobLedger = [];
  const workflowGroups = new Map();
  const jobGroups = new Map();
  const runnerGroups = new Map();
  const slowSteps = [];
  let pageCount = 0;
  let jobViews = 0;
  let reusedJobViews = 0;
  let measuredJobs = 0;
  let skippedJobs = 0;
  let unmeasuredJobs = 0;
  let measuredSteps = 0;
  let skippedSteps = 0;
  let unmeasuredSteps = 0;
  let stepCount = 0;
  let jobSecondsTotal = 0;
  let stepSecondsTotal = 0;
  let inferredOwners = 0;
  let emptyAttempts = 0;
  let viewCount = 0;
  const crossRunJobIds = new Map();
  const retryBreakdown = { failed_attempt_seconds: 0, later_success_attempt_seconds: 0, runs: 0 };

  for (const run of snapshot.runs) {
    if (run.excluded) continue;
    const parent = projectRunForSnapshot(run.initial_parent.metadata, 'Run metadata');
    const wfId = parent.workflow_id;
    const wfName = workflowName(parent);
    const runAttempts = [];
    const perRunJobs = new Map();

    for (const attempt of run.attempts) {
      const attemptStats = {
        number: attempt.number, conclusion: attempt.metadata.conclusion,
        view_job_count: 0,
        owned_job_count: 0,
        reused_job_count: 0,
        measured_job_count: 0,
        skipped_job_count: 0,
        unmeasured_job_count: 0,
        job_seconds: 0,
        failed_before_pass_seconds: 0,
        cancelled_seconds: 0,
        job_ids: [],
        job_sources: [],
        source_url: attemptUrl(snapshot.repository, parent.id, attempt.number),
      };
      const viewJobs = [];

      for (const page of attempt.pages) {
        pageCount += 1;
        for (let jobIndex = 0; jobIndex < page.jobs.length; jobIndex += 1) {
          const job = projectJob(page.jobs[jobIndex], `Run ${parent.id} attempt ${attempt.number} job ${jobIndex + 1}`, parent.id, parent.head_sha);
          viewCount += 1;
          const crossRunIdentity = `${snapshot.repository}:${job.id}`;
          const previousRun = crossRunJobIds.get(crossRunIdentity);
          if (previousRun !== undefined && previousRun !== parent.id) {
            throw new LedgerError('A job ID appears under two different run IDs.');
          }
          crossRunJobIds.set(crossRunIdentity, parent.id);
          const existing = perRunJobs.get(job.id);
          const owner = existing ? existing.owner_attempt : attempt.number;
          if (Object.hasOwn(job, 'run_attempt') && job.run_attempt !== owner) {
            throw new LedgerError('A job run_attempt does not match its first observed attempt.');
          }
          const shape = stableJobShape(job, owner);
          if (existing) {
            if (attempt.number <= existing.owner_attempt) throw new LedgerError('A job is repeated before its owning attempt.');
            if (existing.shape !== shape) throw new LedgerError('Repeated job metadata conflicts across attempts.');
            existing.views += 1;
            attemptStats.reused_job_count += 1;
            reusedJobViews += 1;
            viewJobs.push(existing.record);
            attemptStats.job_ids.push(job.id);
            attemptStats.job_sources.push(jobUrl(snapshot.repository, parent.id, job.id));
            continue;
          }
          const seconds = isSkipped(job) ? null : intervalSeconds(job.started_at, job.completed_at);
          const labels = uniqueStrings(job.labels);
          const record = {
            id: job.id,
            run_id: parent.id,
            workflow_id: wfId,
            workflow: wfName,
            name: job.name, conclusion: job.conclusion,
            owner_attempt: attempt.number,
            ownership: Object.hasOwn(job, 'run_attempt') ? 'declared' : 'inferred',
            repeated_views: 0,
            seconds,
            measurement: isSkipped(job) ? 'skipped' : seconds === null ? 'unmeasured' : 'measured',
            runner_labels: labels,
            source_url: jobUrl(snapshot.repository, parent.id, job.id),
            attempt_url: attemptUrl(snapshot.repository, parent.id, attempt.number),
          };
          const jobState = { owner_attempt: attempt.number, shape, views: 1, record, raw: job };
          perRunJobs.set(job.id, jobState);
          const globalRecord = { ...record };
          jobLedger.push(globalRecord);
          viewJobs.push(globalRecord);
          attemptStats.owned_job_count += 1;
          attemptStats.job_ids.push(job.id);
          attemptStats.job_sources.push(jobUrl(snapshot.repository, parent.id, job.id));

          if (record.ownership === 'inferred') inferredOwners += 1;
          const workflowGroup = addToGroup(workflowGroups, String(wfId), () => ({ workflow_id: wfId, names: new Set(), seconds: 0, jobs: 0, run_ids: new Set(), source_urls: [] }));
          workflowGroup.names.add(wfName);
          workflowGroup.run_ids.add(parent.id);
          workflowGroup.jobs += 1;
          workflowGroup.seconds += seconds || 0;
          workflowGroup.source_urls.push(record.source_url);
          const jobGroupKey = `${wfId}\u0000${job.name}`;
          const jobGroup = addToGroup(jobGroups, jobGroupKey, () => ({ workflow_id: wfId, workflow: wfName, name: job.name, seconds: 0, executions: 0, source_urls: [] }));
          jobGroup.executions += 1;
          jobGroup.seconds += seconds || 0;
          jobGroup.source_urls.push(record.source_url);
          const runnerKey = `${wfId}\u0000${labels.join('\u0000')}`;
          const runnerGroup = addToGroup(runnerGroups, runnerKey, () => ({ workflow_id: wfId, workflow: wfName, labels, seconds: 0, jobs: 0, source_urls: [] }));
          runnerGroup.jobs += 1;
          runnerGroup.seconds += seconds || 0;
          runnerGroup.source_urls.push(record.source_url);

          if (record.measurement === 'measured') {
            measuredJobs += 1;
            attemptStats.measured_job_count += 1;
            attemptStats.job_seconds += seconds;
            jobSecondsTotal += seconds;
          } else if (record.measurement === 'skipped') {
            skippedJobs += 1;
            attemptStats.skipped_job_count += 1;
          } else {
            unmeasuredJobs += 1;
            attemptStats.unmeasured_job_count += 1;
          }

          for (const step of job.steps) {
            stepCount += 1;
            if (isSkipped(step)) {
              skippedSteps += 1;
              continue;
            }
            const stepSeconds = intervalSeconds(step.started_at, step.completed_at);
            if (stepSeconds === null) {
              unmeasuredSteps += 1;
              continue;
            }
            measuredSteps += 1;
            stepSecondsTotal += stepSeconds;
            if (stepSeconds > 0) {
              slowSteps.push({
                workflow_id: wfId,
                workflow: wfName,
                job: job.name,
                step: step.name,
                seconds: stepSeconds,
                attempt: attempt.number,
                run_id: parent.id,
                source_url: record.source_url,
                attempt_url: record.attempt_url,
              });
            }
          }
        }
      }
      attemptStats.view_job_count = viewJobs.length;
      attemptStats.job_ids.sort((left, right) => left - right);
      attemptStats.job_sources = uniqueStrings(attemptStats.job_sources);
      if (viewJobs.length === 0) emptyAttempts += 1;
      runAttempts.push(attemptStats);
    }

    const hasSuccessfulLater = new Map();
    for (const row of runAttempts) {
      hasSuccessfulLater.set(row.number, runAttempts.some((later) => later.number > row.number && later.conclusion === 'success'));
    }
    for (const row of runAttempts) {
      if (['failure', 'timed_out', 'startup_failure'].includes(row.conclusion) && hasSuccessfulLater.get(row.number)) {
        row.failed_before_pass_seconds = row.job_seconds;
        retryBreakdown.failed_attempt_seconds += row.job_seconds;
      }
      if (row.conclusion === 'cancelled') row.cancelled_seconds = row.job_seconds;
    }
    const qualifyingFailures = runAttempts.filter((row) => row.failed_before_pass_seconds > 0 || (['failure', 'timed_out', 'startup_failure'].includes(row.conclusion) && hasSuccessfulLater.get(row.number)));
    if (qualifyingFailures.length) {
      const firstFailure = Math.min(...qualifyingFailures.map((row) => row.number));
      const laterSuccessRows = runAttempts.filter((row) => row.number > firstFailure && row.conclusion === 'success');
      retryBreakdown.runs += 1;
      retryBreakdown.later_success_attempt_seconds += laterSuccessRows.reduce((sum, row) => sum + row.job_seconds, 0);
    }
    for (const attempt of runAttempts) attemptLedger.push({ run_id: parent.id, workflow_id: wfId, workflow: wfName, head_sha: parent.head_sha, ...attempt });
    for (const [jobId, state] of perRunJobs) {
      state.record.repeated_views = state.views - 1;
      const jobIndex = jobLedger.findIndex((entry) => entry.run_id === parent.id && entry.id === jobId);
      if (jobIndex >= 0) jobLedger[jobIndex].repeated_views = state.views - 1;
    }
  }

  const excludedRuns = snapshot.runs.filter((run) => run.excluded).length;
  const includedRuns = snapshot.runs.length - excludedRuns;
  const warnings = [
    `Sample scope: up to ${snapshot.limit} recent completed runs; this is not a date-window or repository-wide audit.`,
  ];
  if (snapshot.sample_kind === 'synthetic_demo') warnings.push('Demo figures come from a synthetic fixture.');
  if (excludedRuns) warnings.push(`${excludedRuns} run(s) above ${ATTEMPT_LIMIT} attempts were excluded from accounting.`);
  if (skippedJobs) warnings.push(`${skippedJobs} skipped job(s) were excluded from elapsed-time totals.`);
  if (unmeasuredJobs) warnings.push(`${unmeasuredJobs} job(s) have missing, malformed, or reversed time intervals.`);
  if (unmeasuredSteps) warnings.push(`${unmeasuredSteps} step(s) have missing, malformed, or reversed time intervals.`);
  if (reusedJobViews) warnings.push(`${reusedJobViews} repeated job view(s) were assigned to the first observed attempt and counted once.`);
  if (inferredOwners) warnings.push(`${inferredOwners} job owner(s) were inferred from first observation because run_attempt was absent.`);
  warnings.push('Elapsed job seconds are not billed minutes and do not imply cost or savings.');

  const workflowTotals = formatGroupRows(workflowGroups, (group) => ({
    workflow_id: group.workflow_id,
    workflow_names: [...group.names].sort(),
    job_count: group.jobs,
    run_count: group.run_ids.size,
    seconds: group.seconds,
    source_urls: uniqueStrings(group.source_urls).slice(0, 5),
  })).filter((row) => row.seconds > 0).sort((left, right) => right.seconds - left.seconds || left.workflow_id - right.workflow_id);
  const jobTotals = formatGroupRows(jobGroups, (group) => ({
    workflow_id: group.workflow_id,
    workflow: group.workflow,
    name: group.name,
    executions: group.executions,
    seconds: group.seconds,
    source_urls: uniqueStrings(group.source_urls).slice(0, 5),
  })).filter((row) => row.seconds > 0).sort((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
  const runnerTotals = formatGroupRows(runnerGroups, (group) => ({
    workflow_id: group.workflow_id,
    workflow: group.workflow,
    labels: group.labels,
    job_count: group.jobs,
    seconds: group.seconds,
    source_urls: uniqueStrings(group.source_urls).slice(0, 5),
  })).filter((row) => row.seconds > 0).sort((left, right) => right.seconds - left.seconds || left.labels.join(',').localeCompare(right.labels.join(',')));
    slowSteps.sort((left, right) => right.seconds - left.seconds || left.step.localeCompare(right.step));
  for (const row of attemptLedger) {
    row.source_url = attemptUrl(snapshot.repository, row.run_id, row.number);
  }
  const normalizedAttemptLedger = attemptLedger.map((row) => ({
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    workflow: row.workflow,
    head_sha: row.head_sha,
    attempt: row.number, conclusion: row.conclusion,
    view_job_count: row.view_job_count,
    owned_job_count: row.owned_job_count,
    reused_job_count: row.reused_job_count,
    measured_job_count: row.measured_job_count,
    skipped_job_count: row.skipped_job_count,
    unmeasured_job_count: row.unmeasured_job_count,
    job_seconds: row.job_seconds,
    failed_before_pass_seconds: row.failed_before_pass_seconds,
    cancelled_seconds: row.cancelled_seconds,
    job_ids: row.job_ids,
    job_sources: row.job_sources,
    source_url: row.source_url,
  }));
  const cancelledAttempts = normalizedAttemptLedger.filter((row) => row.conclusion === 'cancelled' && row.cancelled_seconds > 0).sort((left, right) => right.cancelled_seconds - left.cancelled_seconds);
  const failedBeforePass = normalizedAttemptLedger.filter((row) => row.failed_before_pass_seconds > 0).sort((left, right) => right.failed_before_pass_seconds - left.failed_before_pass_seconds);
  const coverage = {
    sampled_runs: snapshot.runs.length,
    completed_runs_available: snapshot.run_list_total_count,
    included_runs: includedRuns,
    excluded_runs: excludedRuns,
    collection_complete: excludedRuns === 0,
    observed_attempts: normalizedAttemptLedger.length,
    empty_attempts: emptyAttempts,
    page_count: pageCount,
    job_views: viewCount,
    unique_jobs: jobLedger.length,
    measured_jobs: measuredJobs,
    skipped_jobs: skippedJobs,
    unmeasured_jobs: unmeasuredJobs,
    duration_complete: unmeasuredJobs === 0,
    reused_job_views: reusedJobViews,
    inferred_owners: inferredOwners,
    measured_steps: measuredSteps,
    step_count: stepCount,
    skipped_steps: skippedSteps,
    unmeasured_steps: unmeasuredSteps,
    job_seconds: jobSecondsTotal,
    step_seconds: stepSecondsTotal,
  };
  return {
    report_version: 1,
    generated_by: `gha-rerun-ledger ${PACKAGE.version}`,
    repository: snapshot.repository,
    sample_kind: snapshot.sample_kind,
    collected_at: snapshot.collected_at,
    coverage,
    retry_breakdown: retryBreakdown,
    attempt_ledger: normalizedAttemptLedger,
    job_ledger: jobLedger,
    rankings: {
      workflows: workflowTotals.slice(0, 10),
      jobs: jobTotals.slice(0, 10),
      runners: runnerTotals.slice(0, 10),
      slow_steps: slowSteps.slice(0, 10),
      failed_before_pass: failedBeforePass.slice(0, 10),
      cancelled_attempts: cancelledAttempts.slice(0, 10),
    },
    warnings,
  };
}

function ascii(value) {
  let out = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code >= 32 && code <= 126) out += char;
    else if (code <= 255) out += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    else out += `\\u{${code.toString(16).toUpperCase()}}`;
  }
  return out;
}

function markdownText(value) {
  let out = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) {
      out += `\\u{${code.toString(16).toUpperCase()}}`;
    } else if ('\\`*_{}[]()#+-.!|>~'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

function secondsText(value) {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
}

function widthText(value, width) {
  const result = String(value);
  return result.length >= width ? result : result + ' '.repeat(width - result.length);
}

function drawBar(value, max, width = 24) {
  if (!max || value <= 0) return '-'.repeat(width);
  const count = Math.max(1, Math.min(width, Math.round((value / max) * width)));
  return '#'.repeat(count) + '-'.repeat(width - count);
}

function color(value, ansi, enabled) {
  return enabled ? `\u001b[${ansi}m${value}\u001b[0m` : value;
}

function renderText(report, options = {}) {
  const enabled = Boolean(options.color) && !process.env.NO_COLOR;
  const lines = [];
  const kind = report.sample_kind === 'synthetic_demo' ? 'DEMO FIXTURE' : 'SNAPSHOT REPORT';
  lines.push(color(`gha-rerun-ledger | ${kind}`, '1;34', enabled));
  lines.push(`Repository: ${ascii(report.repository)}`);
  lines.push(`Collected: ${ascii(report.collected_at)}`);
  lines.push(`Completed runs: ${report.coverage.sampled_runs} sampled, ${report.coverage.included_runs} included, ${report.coverage.excluded_runs} excluded`);
  lines.push(`Attempts: ${report.coverage.observed_attempts}; jobs: ${report.coverage.unique_jobs} distinct, ${report.coverage.reused_job_views} reused views`);
  lines.push(`Job time: ${secondsText(report.coverage.job_seconds)} seconds; step time: ${secondsText(report.coverage.step_seconds)} seconds`);
  lines.push(`Coverage: ${report.coverage.collection_complete ? 'complete attempt history for included runs' : 'incomplete because some runs were excluded'}; ${report.coverage.unmeasured_jobs} unmeasured jobs; ${report.coverage.skipped_jobs} skipped jobs`);
  lines.push('');
  lines.push('ATTEMPT LEDGER');
  lines.push('RUN       WORKFLOW                 TRY  CONCLUSION       VIEWED OWNED  REUSED  JOB SEC  FAILED BEFORE PASS');
  for (const row of report.attempt_ledger) {
    const label = ascii(row.workflow);
    lines.push(`${widthText(row.run_id, 9)} ${widthText(label, 25)} ${widthText(row.attempt, 4)} ${widthText(ascii(row.conclusion), 16)} ${widthText(row.view_job_count, 6)} ${widthText(row.owned_job_count, 6)} ${widthText(row.reused_job_count, 7)} ${widthText(secondsText(row.job_seconds), 8)} ${secondsText(row.failed_before_pass_seconds)}`);
  }
  lines.push('');
  lines.push('RETRY TIME SPLIT');
  const maxRetry = Math.max(report.retry_breakdown.failed_attempt_seconds, report.retry_breakdown.later_success_attempt_seconds);
  lines.push(`Failed attempts              ${drawBar(report.retry_breakdown.failed_attempt_seconds, maxRetry)}  ${secondsText(report.retry_breakdown.failed_attempt_seconds)} job-seconds`);
  lines.push(`Later successful attempts    ${drawBar(report.retry_breakdown.later_success_attempt_seconds, maxRetry)}  ${secondsText(report.retry_breakdown.later_success_attempt_seconds)} job-seconds`);
  lines.push('Observed elapsed time only. Parallel jobs add together. This is not billed time or savings.');
  lines.push('');
  lines.push('WORKFLOWS BY JOB SECONDS');
  if (report.rankings.workflows.length === 0) lines.push('  none measured');
  for (const row of report.rankings.workflows) {
    lines.push(`  ${ascii(row.workflow_names.join(' / '))} [workflow ${row.workflow_id}]  ${secondsText(row.seconds)} sec  ${row.job_count} jobs`);
  }
  lines.push('');
  lines.push('SLOWEST MEASURED STEPS');
  if (report.rankings.slow_steps.length === 0) lines.push('  none measured');
  for (const row of report.rankings.slow_steps.slice(0, 5)) {
    lines.push(`  ${secondsText(row.seconds)} sec  ${ascii(row.workflow)} / ${ascii(row.job)} / ${ascii(row.step)}  ${ascii(row.source_url)}`);
  }
  lines.push('');
  lines.push('FAILED BEFORE PASS');
  if (report.rankings.failed_before_pass.length === 0) lines.push('  none observed');
  for (const row of report.rankings.failed_before_pass) {
    lines.push(`  run ${row.run_id} attempt ${row.attempt}  ${secondsText(row.failed_before_pass_seconds)} job-seconds  ${ascii(row.source_url)}`);
  }
  lines.push('');
  lines.push('CANCELLED ATTEMPTS');
  if (report.rankings.cancelled_attempts.length === 0) lines.push('  none observed');
  for (const row of report.rankings.cancelled_attempts) {
    lines.push(`  run ${row.run_id} attempt ${row.attempt}  ${secondsText(row.cancelled_seconds)} job-seconds  ${ascii(row.source_url)}`);
  }
  if (report.warnings.length) {
    lines.push('');
    lines.push('WARNINGS AND SCOPE');
    for (const warning of report.warnings) lines.push(`  - ${ascii(warning)}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report) {
  const lines = [
    '# gha-rerun-ledger report',
    '',
    `Repository: ${markdownText(report.repository)}`, '',
    `Collected: ${markdownText(report.collected_at)}`, '',
    `Sample kind: ${markdownText(report.sample_kind)}`, '',
    'Job seconds are elapsed job intervals. Parallel jobs add together. These values are not billed minutes, costs, or savings.', '',
    '## Coverage', '',
    `- Runs: ${report.coverage.sampled_runs} sampled, ${report.coverage.included_runs} included, ${report.coverage.excluded_runs} excluded.`,
    `- Attempts: ${report.coverage.observed_attempts}, including ${report.coverage.empty_attempts} empty attempts.`,
    `- Job views: ${report.coverage.job_views}; distinct jobs: ${report.coverage.unique_jobs}; repeated views: ${report.coverage.reused_job_views}.`,
    `- Measured jobs: ${report.coverage.measured_jobs}; skipped: ${report.coverage.skipped_jobs}; unmeasured: ${report.coverage.unmeasured_jobs}.`,
    `- Job time: ${secondsText(report.coverage.job_seconds)} seconds; measured step time: ${secondsText(report.coverage.step_seconds)} seconds.`, '',
    '## Attempt ledger', '',
    '| Run | Workflow | Attempt | Conclusion | Owned jobs | Reused views | Job seconds | Failed before pass | Source |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of report.attempt_ledger) {
    lines.push(`| ${row.run_id} | ${markdownText(row.workflow)} | ${row.attempt} | ${markdownText(row.conclusion)} | ${row.owned_job_count} | ${row.reused_job_count} | ${secondsText(row.job_seconds)} | ${secondsText(row.failed_before_pass_seconds)} | [attempt](${row.source_url}) |`);
  }
  const retryMax = Math.max(report.retry_breakdown.failed_attempt_seconds, report.retry_breakdown.later_success_attempt_seconds);
  lines.push('', '## Observed retry time split', '', 'Failed attempts  `' + drawBar(report.retry_breakdown.failed_attempt_seconds, retryMax) + '` ' + secondsText(report.retry_breakdown.failed_attempt_seconds) + ' job-seconds');
  lines.push('', 'Later successful attempts  `' + drawBar(report.retry_breakdown.later_success_attempt_seconds, retryMax) + '` ' + secondsText(report.retry_breakdown.later_success_attempt_seconds) + ' job-seconds');
  lines.push('', 'The split describes observed job time. It does not estimate time or money saved.', '', '## Workflow totals', '', '| Workflow ID | Workflow | Jobs | Job seconds | Sources |', '| ---: | --- | ---: | ---: | --- |');
  if (report.rankings.workflows.length === 0) lines.push('| - | No measured work | 0 | 0 | - |');
  for (const row of report.rankings.workflows) {
    const sources = row.source_urls.map((url, index) => `[job ${index + 1}](${url})`).join(', ');
    lines.push(`| ${row.workflow_id} | ${markdownText(row.workflow_names.join(' / '))} | ${row.job_count} | ${secondsText(row.seconds)} | ${sources} |`);
  }
  lines.push('', '## Slow steps', '', '| Seconds | Workflow | Job | Step | Source |', '| ---: | --- | --- | --- | --- |');
  if (report.rankings.slow_steps.length === 0) lines.push('| 0 | - | - | No measured steps | - |');
  for (const row of report.rankings.slow_steps) {
    lines.push(`| ${secondsText(row.seconds)} | ${markdownText(row.workflow)} | ${markdownText(row.job)} | ${markdownText(row.step)} | [job](${row.source_url}) |`);
  }
  lines.push('', '## Warnings', '');
  for (const warning of report.warnings) lines.push(`- ${markdownText(warning)}`);
  lines.push('', '## Data notes', '', '- Skipped and unmeasured jobs remain in coverage counts and do not become zero-second jobs.', '- Repeated job IDs are attributed to their first observed attempt after the saved history and duplicate metadata validate.', '- The sample covers recent completed runs requested from the API. It is not a billing-period report or repository-wide audit.', '- Snapshot files retain run and job API responses. The CLI does not request log files or save authentication headers.', '');
  return lines.join('\n');
}

function projectRunForSnapshot(value, label) {
  const parent = projectParent(value, label);
  if (value.name !== undefined && value.name !== null) parent.name = requireString(value.name, `${label}.name`);
  if (value.head_branch !== undefined && value.head_branch !== null) parent.head_branch = requireString(value.head_branch, `${label}.head_branch`);
  if (value.run_number !== undefined && value.run_number !== null) parent.run_number = requirePositiveInteger(value.run_number, `${label}.run_number`);
  return parent;
}

function projectApiJob(value, label, runId, headSha) {
  projectJob(value, label, runId, headSha);
  return structuredClone(value);
}

function projectAttemptMetadata(value, label, requestedNumber, parent) {
  const meta = projectRunForSnapshot(value, label);
  if (meta.id !== parent.id || meta.workflow_id !== parent.workflow_id || meta.head_sha !== parent.head_sha) {
    throw new LedgerError(`${label} does not match the parent run.`);
  }
  if (meta.run_attempt !== requestedNumber) throw new LedgerError(`${label}.run_attempt does not match the requested attempt.`);
  return meta;
}

function execFileJson(binary, args, options = {}) {
  const invoke = options.execFileImpl || execFile;
  return new Promise((resolve, reject) => {
    invoke(binary, args, {
      encoding: 'utf8',
      timeout: API_TIMEOUT_MS,
      maxBuffer: API_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      cwd: options.cwd,
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout));
    });
  });
}

async function requestGitHub(endpoint, options = {}) {
  let stdout;
  try {
    stdout = await execFileJson('gh', [
      'api', '--method', 'GET', '--hostname', 'github.com',
      '-H', 'Accept: application/vnd.github+json', endpoint,
    ], options);
  } catch {
    throw new LedgerError(`GitHub API request failed or timed out: GET ${endpoint}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new LedgerError(`GitHub API response was not valid JSON: GET ${endpoint}`);
  }
}

async function inferRepository(options = {}) {
  try {
    const remote = await execFileJson('git', ['config', '--get', 'remote.origin.url'], {
      execFileImpl: options.execFileImpl,
      cwd: options.cwd || process.cwd(),
    });
    return repositoryFromRemote(remote);
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError('Could not read remote.origin.url; pass --repo owner/name.');
  }
}

function isoNow() {
  return new Date().toISOString();
}

function validateRunList(value, limit) {
  const payload = requireObject(value, 'Workflow runs response');
  const total = requireNonnegativeInteger(payload.total_count, 'Workflow runs response.total_count');
  const rows = requireArray(payload.workflow_runs, 'Workflow runs response.workflow_runs');
  if (rows.length > limit) throw new LedgerError('Workflow runs response exceeded the requested limit.');
  if (rows.length !== Math.min(total, limit)) throw new LedgerError('Workflow run-list row count is incomplete.');
  const ids = new Set();
  return rows.map((row, index) => {
    const meta = projectRunForSnapshot(row, `Workflow runs response.workflow_runs[${index}]`);
    if (meta.status !== 'completed') throw new LedgerError('Workflow runs response included a non-completed run.');
    if (ids.has(meta.id)) throw new LedgerError('Workflow runs response repeated a run ID.');
    ids.add(meta.id);
    return { meta, raw: structuredClone(row) };
  });
}

async function readJobPages(repository, parent, attemptNumber, request = requestGitHub, now = isoNow) {
  const pages = [];
  let pageNumber = 1;
  let totalCount = null;
  let received = 0;
  const seen = new Set();
  while (true) {
    const endpoint = `/repos/${repository}/actions/runs/${parent.id}/attempts/${attemptNumber}/jobs?per_page=${PAGE_SIZE}&page=${pageNumber}`;
    const response = await request(endpoint);
    const payload = requireObject(response, `Jobs response for attempt ${attemptNumber}, page ${pageNumber}`);
    const pageTotal = requireNonnegativeInteger(payload.total_count, 'Jobs response.total_count');
    const rawJobs = requireArray(payload.jobs, 'Jobs response.jobs');
    if (totalCount === null) totalCount = pageTotal;
    if (pageTotal !== totalCount) throw new LedgerError(`Job page total_count changed on attempt ${attemptNumber}.`);
    const expectedPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const expectedRows = totalCount === 0 ? 0 : Math.min(PAGE_SIZE, totalCount - (pageNumber - 1) * PAGE_SIZE);
    if (rawJobs.length !== expectedRows) throw new LedgerError(`Job page ${pageNumber} was incomplete for attempt ${attemptNumber}.`);
    const jobs = rawJobs.map((job, index) => projectApiJob(job, `Jobs response.jobs[${index}]`, parent.id, parent.head_sha));
    for (const job of jobs) {
      if (seen.has(job.id)) throw new LedgerError(`Job page ${pageNumber} repeated a job ID in attempt ${attemptNumber}.`);
      seen.add(job.id);
    }
    pages.push({ page: pageNumber, per_page: PAGE_SIZE, total_count: pageTotal, fetched_at: now(), jobs });
    received += jobs.length;
    if (pageNumber >= expectedPages) break;
    pageNumber += 1;
  }
  if (received !== totalCount) throw new LedgerError(`Job pagination ended before all rows arrived for attempt ${attemptNumber}.`);
  return pages;
}

async function collectSnapshot(repositoryValue, limit, options = {}) {
  const repository = parseRepository(repositoryValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LedgerError('--limit must be from 1 through 100.');
  const request = options.request || ((endpoint) => requestGitHub(endpoint, options));
  const safeRequest = async (endpoint) => {
    try {
      return await request(endpoint);
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      throw new LedgerError(`GitHub API request failed or timed out: GET ${endpoint}`);
    }
  };
  const now = options.now || isoNow;
  const collectedAt = now();
  requireObservationTime(collectedAt, 'Collection time');
  const runsEndpoint = `/repos/${repository}/actions/runs?status=completed&per_page=${limit}`;
  const listPayload = await safeRequest(runsEndpoint);
  const initialListReadAt = now();
  const runRows = validateRunList(listPayload, limit);
  const runs = [];
  for (const runRow of runRows) {
    const parent = runRow.meta;
    const initial = { observed_at: initialListReadAt, metadata: runRow.raw };
    const attempts = [];
    if (parent.run_attempt <= ATTEMPT_LIMIT) {
      for (let number = 1; number <= parent.run_attempt; number += 1) {
        const requestedAt = now();
        const metadataRaw = await safeRequest(`/repos/${repository}/actions/runs/${parent.id}/attempts/${number}`);
        const fetchedAt = now();
        const metadata = projectAttemptMetadata(metadataRaw, `Attempt ${number} metadata`, number, parent);
        const pages = await readJobPages(repository, parent, number, safeRequest, now);
        attempts.push({ number, requested_at: requestedAt, fetched_at: fetchedAt, metadata: structuredClone(metadataRaw), pages });
      }
    }
    const finalRaw = await safeRequest(`/repos/${repository}/actions/runs/${parent.id}`);
    const finalObservedAt = now();
    const finalMetadata = projectRunForSnapshot(finalRaw, 'Final parent metadata');
    if (parentFingerprint(parent) !== parentFingerprint(finalMetadata)) {
      throw new LedgerError(`Run ${parent.id} changed while its attempt history was collected.`);
    }
    runs.push({
      excluded: parent.run_attempt > ATTEMPT_LIMIT,
      ...(parent.run_attempt > ATTEMPT_LIMIT ? { excluded_reason: 'attempt_limit_exceeded' } : {}),
      initial_parent: initial,
      final_parent: { observed_at: finalObservedAt, metadata: structuredClone(finalRaw) },
      attempts,
    });
  }
  return projectSnapshot({
    schema_version: SCHEMA_VERSION,
    repository,
    sample_kind: 'live_api',
    collected_at: collectedAt,
    limit,
    run_list_total_count: requireNonnegativeInteger(listPayload.total_count, 'Workflow runs response.total_count'),
    runs,
  });
}

function parseArgs(args) {
  const options = { limit: 20, hasLimit: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = () => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new LedgerError(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--input') options.input = nextValue();
    else if (arg === '--repo') options.repo = parseRepository(nextValue());
    else if (arg === '--limit') {
      const value = nextValue();
      if (!/^[0-9]+$/.test(value)) throw new LedgerError('--limit must be an integer from 1 through 100.');
      options.limit = Number(value);
      options.hasLimit = true;
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new LedgerError('--limit must be an integer from 1 through 100.');
    } else if (arg === '--save-snapshot') options.saveSnapshot = nextValue();
    else if (arg === '--markdown') options.markdown = nextValue();
    else if (arg === '--json') options.json = true;
    else throw new LedgerError(`Unknown option: ${ascii(arg)}. Run --help for usage.`);
  }
  if (options.help || options.version) return options;
  if (Number(Boolean(options.demo)) + Number(Boolean(options.input)) > 1) throw new LedgerError('Use only one of --demo or --input.');
  if (options.hasLimit && (options.demo || options.input)) throw new LedgerError('--limit applies only to live collection.');
  if (options.repo && (options.demo || options.input)) throw new LedgerError('--repo applies only to live collection.');
  if (options.saveSnapshot && (options.demo || options.input)) throw new LedgerError('--save-snapshot applies only to live collection.');
  if (options.saveSnapshot && options.saveSnapshot === '-') throw new LedgerError('--save-snapshot needs a file path.');
  if (options.markdown && options.markdown === '-') throw new LedgerError('--markdown needs a file path.');
  return options;
}

function helpText() {
  return [
    'gha-rerun-ledger - inspect GitHub Actions attempts and replay saved metadata',
    '',
    'Usage:',
    '  gha-rerun-ledger [--repo owner/name] [--limit 1..100] [--save-snapshot FILE]',
    '  gha-rerun-ledger --input FILE [--json] [--markdown FILE]',
    '  gha-rerun-ledger --demo [--json] [--markdown FILE]',
    '',
    'Options:',
    '  --repo owner/name     Select a github.com repository for live collection',
    '  --limit N             Sample up to N recent completed runs (default: 20)',
    '  --save-snapshot FILE  Save attempt and job metadata for offline replay',
    '  --input FILE          Replay a schema version 1 snapshot without network access',
    '  --demo                Run the labeled synthetic fixture without git or gh',
    '  --json                Write the report as JSON to stdout',
    '  --markdown FILE       Write a Markdown report',
    '  --version             Print the package version',
    '  --help                Print this help',
    '',
    'Live collection uses GET-only gh api requests for github.com. It needs gh authentication.',
    'Input replay and the demo do not need gh, credentials, git, or network access.',
    'Exit status is 0 for a valid report and 2 for usage, collection, or snapshot errors.',
  ].join('\n') + '\n';
}

async function loadDemoSnapshot() {
  const file = path.join(__dirname, '..', 'fixtures', 'demo-snapshot.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new LedgerError('Could not load the packaged demo fixture.');
  }
}

async function readSnapshotFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new LedgerError('Could not read the input snapshot file.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LedgerError('Input snapshot is not valid JSON.');
  }
}

async function writeFile(file, content, label) {
  try {
    await fs.writeFile(file, content, 'utf8');
  } catch {
    throw new LedgerError(`Could not write the ${label} file.`);
  }
}

async function main(args, dependencies = {}) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${PACKAGE.version}\n`);
    return 0;
  }
  let snapshot;
  if (options.demo) snapshot = await loadDemoSnapshot();
  else if (options.input) snapshot = await readSnapshotFile(options.input);
  else {
    const repository = options.repo || await inferRepository(dependencies);
    snapshot = await collectSnapshot(repository, options.limit, dependencies);
  }
  const report = makeReport(snapshot);
  if (options.saveSnapshot) await writeFile(options.saveSnapshot, `${JSON.stringify(snapshot, null, 2)}\n`, 'snapshot');
  if (options.markdown) await writeFile(options.markdown, renderMarkdown(report), 'Markdown report');
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderText(report, { color: Boolean(process.stdout.isTTY) }));
  return 0;
}

module.exports = {
  ATTEMPT_LIMIT,
  API_MAX_BUFFER,
  API_TIMEOUT_MS,
  LedgerError,
  PAGE_SIZE,
  collectSnapshot,
  drawBar,
  intervalSeconds,
  makeReport,
  main,
  markdownText,
  parseArgs,
  projectSnapshot,
  renderMarkdown,
  renderText,
  repositoryFromRemote,
  requestGitHub,
};

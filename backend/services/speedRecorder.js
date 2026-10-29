// Reads and writes alphapulldown_speed_samples, the anonymised speed
// database (see backend/db/schema.sql for what it may and may not hold).
//
// Nothing outside this module's own backend ever writes here, and there is
// no route for it: the MSA and co-folding stages call recordSamples() with
// what they measured. sanitiseSample() copies only the whitelisted numeric
// and label fields into the row, so a caller that passes more (a protein
// name, a job id, an owner) cannot leak it into the table.

const STAGES = ['msa', 'fold'];
const OUTCOMES = ['ok', 'oom', 'timeout', 'failed'];
const LABEL = /^[A-Za-z0-9_.+/-]{0,50}$/;
const HARDWARE_LABEL = /^[A-Za-z0-9_.+/-]{0,100}$/;
const MAX_LENGTH = 100000;
const MAX_SECONDS = 60 * 60 * 24 * 60; // a job longer than 60 days is a bad reading
// The estimator learns from at most this many of the newest rows per stage.
const LOAD_LIMIT = 20000;

function isCount(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

// Returns the row to store, or null when the sample is unusable. day is
// 'YYYY-MM-DD' (the caller's clock, so this stays testable).
function sanitiseSample(sample, day) {
  if (!sample || !STAGES.includes(sample.stage)) return null;
  const method = sample.method === undefined ? '' : sample.method;
  const hardware = sample.hardware === undefined ? '' : sample.hardware;
  if (typeof method !== 'string' || !LABEL.test(method)) return null;
  if (typeof hardware !== 'string' || !HARDWARE_LABEL.test(hardware)) return null;
  if (!OUTCOMES.includes(sample.outcome)) return null;
  if (!isCount(sample.lenA, MAX_LENGTH)) return null;

  const lenB = sample.lenB === undefined || sample.lenB === null ? null : sample.lenB;
  if (lenB !== null && !isCount(lenB, MAX_LENGTH)) return null;
  if (sample.stage === 'msa' && lenB !== null) return null;
  const totalLen = sample.lenA + (lenB || 0);

  if (!Number.isInteger(sample.runSeconds) || sample.runSeconds < 0 || sample.runSeconds > MAX_SECONDS) return null;
  const queue = sample.queueSeconds === undefined || sample.queueSeconds === null ? null : sample.queueSeconds;
  if (queue !== null && (!Number.isInteger(queue) || queue < 0 || queue > MAX_SECONDS)) return null;

  return {
    stage: sample.stage,
    len_a: sample.lenA,
    len_b: lenB,
    total_len: totalLen,
    method,
    hardware,
    outcome: sample.outcome,
    run_seconds: sample.runSeconds,
    queue_seconds: queue,
    sampled_on: day
  };
}

// Stores the usable samples and returns how many were kept. The caller marks
// its own private job rows as ingested (that link is never stored here).
async function recordSamples(conn, samples, day = new Date().toISOString().slice(0, 10)) {
  const rows = samples.map(s => sanitiseSample(s, day)).filter(Boolean);
  if (rows.length === 0) return 0;
  await conn.batch(
    `INSERT INTO alphapulldown_speed_samples
       (stage, len_a, len_b, total_len, method, hardware, outcome, run_seconds, queue_seconds, sampled_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.map(r => [r.stage, r.len_a, r.len_b, r.total_len, r.method, r.hardware, r.outcome, r.run_seconds, r.queue_seconds, r.sampled_on])
  );
  return rows.length;
}

// The rows the estimator learns from, in its own shape.
async function loadSamples(conn, stage) {
  const rows = await conn.query(
    `SELECT method, hardware, total_len, run_seconds, outcome FROM alphapulldown_speed_samples
     WHERE stage = ? ORDER BY id DESC LIMIT ?`,
    [stage, LOAD_LIMIT]
  );
  return rows.map(r => ({
    method: r.method,
    hardware: r.hardware,
    totalLen: Number(r.total_len),
    runSeconds: Number(r.run_seconds),
    outcome: r.outcome
  }));
}

module.exports = { STAGES, OUTCOMES, sanitiseSample, recordSamples, loadSamples };

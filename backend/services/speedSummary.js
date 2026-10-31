// What the staff speed-statistics view shows: the anonymised speed samples
// summarised per class (stage, method, hardware - exactly the classes the
// estimator learns from), so staff can see which estimates rest on how much
// data. Pure functions over plain rows - no database, no clock - so they are
// unit-tested without a running mff-core. The rows carry no names to begin
// with (see speedRecorder.js), so nothing here can reveal any.

const { MIN_SAMPLES, GOOD_SAMPLES, quantile } = require('./speedEstimator');

const STAGE_ORDER = ['msa', 'fold'];
// Upper edges, in amino acids, of the size bands each class is split into.
const BAND_EDGES = [250, 500, 1000, 1500, 2000, 3000, 5000];
const MAX_GROUPS = 200;
const ACTIVITY_DAYS = 30;

const ok = row => row.outcome === 'ok';

function spread(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p25: Math.round(quantile(sorted, 0.25)),
    p50: Math.round(quantile(sorted, 0.5)),
    p90: Math.round(quantile(sorted, 0.9))
  };
}

// 'none' below the estimator's minimum (no estimate is given), 'low' below
// the good threshold, otherwise 'good' - the same thresholds the stats strip
// uses, so the two views never disagree.
function levelFor(finished) {
  if (finished < MIN_SAMPLES) return 'none';
  return finished >= GOOD_SAMPLES ? 'good' : 'low';
}

function bandLabel(index) {
  if (index === 0) return `up to ${BAND_EDGES[0]}`;
  if (index === BAND_EDGES.length) return `over ${BAND_EDGES[BAND_EDGES.length - 1]}`;
  return `${BAND_EDGES[index - 1] + 1} - ${BAND_EDGES[index]}`;
}

function bandsOf(rows) {
  const buckets = BAND_EDGES.concat([Infinity]).map(() => []);
  rows.forEach(row => {
    const index = BAND_EDGES.findIndex(edge => row.totalLen <= edge);
    buckets[index === -1 ? BAND_EDGES.length : index].push(row);
  });
  return buckets
    .map((bucket, index) => ({
      label: bandLabel(index),
      samples: bucket.length,
      finished: bucket.filter(ok).length,
      run: spread(bucket.filter(ok).map(r => r.runSeconds))
    }))
    .filter(band => band.samples > 0);
}

function summariseGroup(stage, method, hardware, rows) {
  const finished = rows.filter(ok);
  const lengths = rows.map(r => r.totalLen);
  const queue = rows.map(r => r.queueSeconds).filter(v => v !== null && v !== undefined);
  const count = outcome => rows.filter(r => r.outcome === outcome).length;
  return {
    stage,
    method,
    hardware,
    samples: rows.length,
    finished: finished.length,
    oom: count('oom'),
    timeout: count('timeout'),
    failed: count('failed'),
    level: levelFor(finished.length),
    run: spread(finished.map(r => r.runSeconds)),
    queue: spread(queue),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    bands: bandsOf(rows)
  };
}

// rows: { stage, method, hardware, totalLen, runSeconds, queueSeconds?,
// outcome }. Returns the classes, msa before fold and the best-measured
// first, capped at MAX_GROUPS (the rest are counted, not listed).
function summariseSamples(rows) {
  const byClass = new Map();
  rows.forEach(row => {
    const key = JSON.stringify([row.stage, row.method, row.hardware]);
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(row);
  });
  const groups = [...byClass.entries()]
    .map(([key, members]) => summariseGroup(...JSON.parse(key), members))
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
      || b.samples - a.samples
      || a.method.localeCompare(b.method)
      || a.hardware.localeCompare(b.hardware));
  return { groups: groups.slice(0, MAX_GROUPS), groupsOmitted: Math.max(0, groups.length - MAX_GROUPS) };
}

// What a method/hardware label means, in words. Unknown labels (older
// samples, a changed scheme) come back as they are, never as a guess.
function describeLabels(stage, method, hardware) {
  let methodText = method || 'not recorded';
  let hardwareText = hardware || 'not recorded';
  if (stage === 'msa') {
    if (method === 'mmseqs2') methodText = 'MMseqs2 server search';
    else if (method === 'local') methodText = 'Local database search';
    const parts = /^(.+)\/(\d+)cpu$/.exec(hardware);
    if (parts) hardwareText = `${parts[2]} CPUs, ${parts[1] === 'default' ? 'default partition' : `partition ${parts[1].replace(/\+/g, ' or ')}`}`;
  } else {
    const parts = /^s(\d+)-(msadefault|mmseqs2|localdb)(-tpl)?(-reuse)?$/.exec(method);
    if (parts) {
      const search = { msadefault: 'ABCFold chooses the search', mmseqs2: 'MMseqs2 server', localdb: 'local database' }[parts[2]];
      methodText = [
        `${parts[1]} seed${parts[1] === '1' ? '' : 's'}`,
        search,
        parts[3] ? 'templates' : 'no templates',
        parts[4] ? 'MSAs from the MSA tab' : null
      ].filter(Boolean).join(', ');
    }
    const gpus = /^gpu(\d+)$/.exec(hardware);
    if (gpus) hardwareText = `${gpus[1]} GPU${gpus[1] === '1' ? '' : 's'}`;
  }
  return { methodText, hardwareText };
}

// The last `days` days ending at `today` ('YYYY-MM-DD'), oldest first, each
// with its sample count per stage; days with no samples are zero rather than
// missing, so the chart shows quiet days as quiet. counts: [{ day, stage, n }].
function lastDays(counts, today, days = ACTIVITY_DAYS) {
  const end = Date.parse(`${today}T00:00:00Z`);
  const series = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    series.push({ day: new Date(end - back * 86400000).toISOString().slice(0, 10), msa: 0, fold: 0 });
  }
  const byDay = new Map(series.map(entry => [entry.day, entry]));
  counts.forEach(({ day, stage, n }) => {
    const entry = byDay.get(day);
    if (entry && STAGE_ORDER.includes(stage)) entry[stage] += n;
  });
  return series;
}

module.exports = { ACTIVITY_DAYS, MAX_GROUPS, BAND_EDGES, levelFor, summariseSamples, describeLabels, lastDays };

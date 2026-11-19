// Co-folding (GPU) tab: shows which bait-candidate pairs a run would fold
// (how many, how large, what it should take), starts it, and follows every
// pair. Each pair is its own ABCFold job; the backend submits them through the
// ABCFold module as slots free up and records how long each one took. Only
// ever touches core through the coreApi prop; all calls go to this module's
// own /alphapulldown routes.
import React, { useCallback, useEffect, useState } from 'react';
import { formatDuration } from './formatDuration';
import { errorText, badgeClass as badgeClassFor, formatWhen } from './runUi';
import styles from '../styles/MsaTab.module.css';
import own from '../styles/CofoldTab.module.css';

const POLL_MS = 10000;
const QUICK_POLL_MS = 1500;
const PLAN_DELAY_MS = 350;
const PAGE = 100;
const GROUPS = [
  ['', 'All pairs'], ['queued', 'Waiting to be submitted'], ['running', 'Submitted / running'],
  ['done', 'Done'], ['failed', 'Failed'], ['cancelled', 'Cancelled']
];
const MSA_CHOICES = [
  ['default', "As set in the ABCFold module"],
  ['yes', 'Public MMseqs2 server'],
  ['no', 'Local database']
];
const DEFAULT_OPTIONS = {
  seeds: 1, gpuCount: 1, mmseqs2: 'default', templates: false, reuseMsa: false,
  includeOversize: false, limit: '', baits: []
};

function badgeClass(state) {
  return badgeClassFor(styles, state);
}

function pairSeconds(item) {
  if (!item.startedAt || !item.endedAt) return null;
  return Math.max(0, Math.round((new Date(item.endedAt) - new Date(item.startedAt)) / 1000));
}

// The query string the plan route reads (the run route takes the same as JSON).
function planParams(options) {
  return {
    seeds: options.seeds,
    gpuCount: options.gpuCount,
    mmseqs2: options.mmseqs2,
    templates: options.templates ? 1 : 0,
    reuseMsa: options.reuseMsa ? 1 : 0,
    includeOversize: options.includeOversize ? 1 : 0,
    limit: options.limit,
    baits: options.baits.join(',')
  };
}

function runBody(options) {
  return {
    seeds: Number(options.seeds),
    gpuCount: Number(options.gpuCount),
    mmseqs2: options.mmseqs2,
    templates: options.templates,
    reuseMsa: options.reuseMsa,
    includeOversize: options.includeOversize,
    limit: options.limit === '' ? null : Number(options.limit),
    baits: options.baits.length > 0 ? options.baits : null
  };
}

function EstimateLine({ plan }) {
  const e = plan.estimate;
  if (!e) return null;
  if (!e.available) {
    return (
      <p className={own.estimate}>
        {`No time estimate for these settings yet: ${e.samples || 0} of ${e.needed || 5} finished pairs recorded with them. `}
        Every finished pair adds its speed.
      </p>
    );
  }
  const min = e.lowerBound ? 'at least ' : '';
  return (
    <p className={own.estimate}>
      {`Estimated ${min}${formatDuration(e.wallSeconds.typical)} with ${e.slots} at once `}
      {`(slow case ${formatDuration(e.wallSeconds.slow)}), about ${min}${e.resourceHours.typical.toFixed(1)} GPU-hours. `}
      {`Confidence ${e.confidence === 'good' ? 'good' : 'low'} (${e.samples.toLocaleString()} samples); queue waiting time is not included.`}
    </p>
  );
}

function PlanPanel({ plan, options, onOptions, onStart, starting }) {
  if (!plan) return <div className={styles.panel}>Loading...</div>;
  const set = patch => onOptions({ ...options, ...patch });
  const blocked = plan.problems.length > 0 || plan.toRun === 0 || plan.busy;
  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>New run</h4>
      {plan.problems.map(text => <p key={text} className={styles.warning}>{text}</p>)}

      <div className={own.form}>
        <label className={own.field}>
          Model seeds
          <input className={own.number} type="number" min="1" max="20" value={options.seeds} onChange={e => set({ seeds: e.target.value })} />
        </label>
        <label className={own.field}>
          GPUs per pair
          <input className={own.number} type="number" min="1" max="8" value={options.gpuCount} onChange={e => set({ gpuCount: e.target.value })} />
        </label>
        <label className={own.field}>
          MSA search
          <select className={styles.select} value={options.mmseqs2} onChange={e => set({ mmseqs2: e.target.value })}>
            {MSA_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className={own.field}>
          Only the first N pairs
          <input className={own.number} type="number" min="1" placeholder="all" value={options.limit} onChange={e => set({ limit: e.target.value })} />
        </label>
        {plan.baits.length > 1 && (
          <label className={own.field}>
            Baits (none selected = all)
            <select
              multiple
              size={Math.min(6, plan.baits.length)}
              className={own.baitList}
              value={options.baits}
              onChange={e => set({ baits: Array.from(e.target.selectedOptions, o => o.value) })}
            >
              {plan.baits.map(b => <option key={b.name} value={b.name}>{`${b.name} (${b.length.toLocaleString()} aa)`}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className={own.checks}>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={options.templates} onChange={e => set({ templates: e.target.checked })} />
          <span>Use structural templates</span>
        </label>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={options.reuseMsa} onChange={e => set({ reuseMsa: e.target.checked })} />
          <span>
            {`Hand over the MSAs from the MSA tab (${plan.msa.reusable.toLocaleString()} of ${plan.msa.proteins.toLocaleString()} proteins have one)`}
          </span>
        </label>
        {options.reuseMsa && (
          <span className={styles.hint}>
            Only proteins searched with MMseqs2 leave a reusable MSA file. This takes effect once the ABCFold module accepts
            per-chain MSA files; until then it searches for its own.
          </span>
        )}
        {plan.oversize > 0 && (
          <label className={styles.checkboxField}>
            <input type="checkbox" checked={options.includeOversize} onChange={e => set({ includeOversize: e.target.checked })} />
            <span>{`Also fold the ${plan.oversize.toLocaleString()} pairs over ${plan.limitAA.toLocaleString()} amino acids (likely to run out of memory)`}</span>
          </label>
        )}
      </div>

      {plan.selected > 0 && (
        <p className={styles.summary}>
          <strong>{plan.toRun.toLocaleString()}</strong>
          {` of ${plan.selected.toLocaleString()} pairs to fold`}
          {plan.alreadyDone > 0 ? `, ${plan.alreadyDone.toLocaleString()} already done` : ''}
          {plan.oversize > 0 && !options.includeOversize ? `, ${plan.oversize.toLocaleString()} held back for size` : ''}
          {`. One ABCFold job per pair, at most ${plan.maxParallel} at once.`}
        </p>
      )}
      {plan.toRun > 0 && <EstimateLine plan={plan} />}
      {plan.busy && <p className={styles.warning}>Pairs of this project are still queued or running. Wait for them or cancel that run first.</p>}

      {plan.preview.length > 0 && (
        <table className={styles.table}>
          <thead><tr><th>{plan.mode === 'homo_oligomer' ? 'Protein' : 'Bait'}</th><th>Candidate</th><th className={styles.numeric}>Amino acids</th></tr></thead>
          <tbody>
            {plan.preview.map(p => (
              <tr key={`${p.bait}/${p.cand}`}>
                <td className={styles.mono}>{p.bait}</td>
                <td className={styles.mono}>{p.cand || '—'}</td>
                <td className={styles.numeric}>{(p.lenA + (p.lenB || 0)).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.toRun > plan.preview.length && <p className={styles.muted}>{`Showing the first ${plan.preview.length}.`}</p>}

      <div className={styles.controls}>
        <button type="button" className={styles.btnGreen} onClick={onStart} disabled={blocked || starting}>
          {starting ? 'Starting...' : `Run ${plan.toRun.toLocaleString()} pairs`}
        </button>
      </div>
    </div>
  );
}

function Segments({ counts }) {
  const pct = n => `${counts.total > 0 ? (n / counts.total) * 100 : 0}%`;
  return (
    <div className={own.segments}>
      <div className={own.segDone} style={{ width: pct(counts.done) }} />
      <div className={own.segRunning} style={{ width: pct(counts.running) }} />
      <div className={own.segFailed} style={{ width: pct(counts.failed) }} />
      <div className={own.segCancelled} style={{ width: pct(counts.cancelled) }} />
    </div>
  );
}

function RunCard({ run, open, onToggle, onCancel, onRetry, onDelete, busy }) {
  const c = run.counts;
  const o = run.options;
  const unfinished = c.queued + c.running > 0;
  return (
    <div className={styles.runCard}>
      <div className={styles.runHeader}>
        <strong>{`Run ${run.id}`}</strong>
        <span className={`${styles.badge} ${run.cancelledAt ? styles.badgeGray : (run.active ? styles.badgeBlue : (c.failed > 0 ? styles.badgeRed : styles.badgeGreen))}`}>
          {run.cancelledAt ? 'Cancelled' : (run.active ? 'Running' : (c.failed > 0 ? 'Finished with failures' : 'Done'))}
        </span>
        <span className={styles.muted}>{`${o.seeds} seed${o.seeds === 1 ? '' : 's'}, ${o.gpuCount} GPU${o.gpuCount === 1 ? '' : 's'}`}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.btnBlue} onClick={onToggle}>{open ? 'Hide pairs' : 'Pairs'}</button>
        {c.failed > 0 && !run.cancelledAt && <button type="button" className={styles.btnGreen} onClick={onRetry} disabled={busy}>Retry failed</button>}
        {unfinished && <button type="button" className={styles.btnRed} onClick={onCancel} disabled={busy}>Cancel</button>}
        {!unfinished && <button type="button" className={styles.btnGray} onClick={onDelete} disabled={busy}>Delete</button>}
      </div>
      <Segments counts={c} />
      <div className={styles.runMeta}>
        {`${c.done.toLocaleString()} of ${c.total.toLocaleString()} done`}
        {c.running > 0 ? `, ${c.running.toLocaleString()} running` : ''}
        {c.queued > 0 ? `, ${c.queued.toLocaleString()} waiting` : ''}
        {c.failed > 0 && <span className={styles.failedText}>{`, ${c.failed.toLocaleString()} failed`}</span>}
        {c.cancelled > 0 ? `, ${c.cancelled.toLocaleString()} cancelled` : ''}
        {` · started ${formatWhen(run.createdAt)}`}
        {run.remaining && run.remaining.available ? ` · about ${formatDuration(run.remaining.wallSeconds.typical)} left` : ''}
      </div>
      {run.waiting && (
        <div className={styles.hint}>
          {`Keep this page open: pairs are handed to ABCFold as slots free up (${c.running} of ${run.maxParallel} in flight). Nothing is submitted while the page is closed.`}
        </div>
      )}
      {run.submitError && <div className={styles.warning}>{`Could not submit the next pair: ${run.submitError}`}</div>}
      {run.statusError && <div className={styles.warning}>{`Could not refresh the state from ABCFold: ${run.statusError}`}</div>}
    </div>
  );
}

function RunDetail({ api, projectId, run }) {
  const [group, setGroup] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { setOffset(0); }, [group]);

  const c = run.counts;
  useEffect(() => {
    api.get(`/alphapulldown/projects/${projectId}/cofold/runs/${run.id}/items`, { params: { group, offset, limit: PAGE } })
      .then(res => { setPage(res.data); setError(''); })
      .catch(err => setError(errorText(err)));
  }, [api, projectId, run.id, group, offset, c.queued, c.running, c.done, c.failed, c.cancelled]);

  return (
    <div className={styles.detail}>
      {error && <p className={styles.errorText}>{error}</p>}
      <div className={styles.controls}>
        <span>Show:</span>
        <select className={styles.select} value={group} onChange={e => setGroup(e.target.value)}>
          {GROUPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {page && (
          <span className={own.pager}>
            {`${page.total === 0 ? 0 : page.offset + 1}-${Math.min(page.total, page.offset + PAGE)} of ${page.total.toLocaleString()}`}
            <button type="button" className={styles.btnGray} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
            <button type="button" className={styles.btnGray} disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </span>
        )}
      </div>
      {page && page.items.length === 0 && <p className={styles.empty}>No pairs here.</p>}
      {page && page.items.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr><th>Bait</th><th>Candidate</th><th className={styles.numeric}>Amino acids</th><th>State</th><th className={styles.numeric}>Run time</th><th>ABCFold job</th><th /></tr>
          </thead>
          <tbody>
            {page.items.map(item => {
              const seconds = pairSeconds(item);
              return (
                <tr key={item.id}>
                  <td className={styles.mono}>{item.bait}</td>
                  <td className={styles.mono}>{item.cand || '—'}</td>
                  <td className={styles.numeric}>{(item.lenA + (item.lenB || 0)).toLocaleString()}</td>
                  <td><span className={`${styles.badge} ${badgeClass(item.state)}`}>{item.state}</span></td>
                  <td className={styles.numeric}>{seconds === null ? '—' : formatDuration(seconds)}</td>
                  <td className={styles.mono}>{item.abcfoldJobId || '—'}</td>
                  <td className={styles.errorText}>{item.error || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CofoldTab({ coreApi, project, onChanged }) {
  const { api } = coreApi;
  const projectId = project.id;
  const base = `/alphapulldown/projects/${projectId}/cofold`;
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [plan, setPlan] = useState(null);
  const [runs, setRuns] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const loadPlan = useCallback(() => api.get(`${base}/plan`, { params: planParams(options) })
    .then(res => { setPlan(res.data); setError(''); })
    .catch(err => setError(errorText(err))), [api, base, options]);

  const loadRuns = useCallback(() => api.get(`${base}/runs`)
    .then(res => {
      setRuns(res.data.runs);
      // Finished pairs add their timings to the speed database, which changes the estimates.
      if (res.data.ingestedNow > 0) onChanged();
    })
    .catch(err => setError(errorText(err))), [api, base, onChanged]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setOptions(DEFAULT_OPTIONS);
    setPlan(null);
    setRuns(null);
    setOpenId(null);
    setError('');
  }, [projectId]);

  // Typing in a number box should not ask the server on every keystroke.
  useEffect(() => {
    const timer = setTimeout(loadPlan, PLAN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loadPlan]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const anyActive = !!runs && runs.some(r => r.active);
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = setInterval(() => { loadRuns(); loadPlan(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, loadRuns, loadPlan]);

  // The backend hands out only a few pairs per call; while it says there is
  // more to submit, ask again soon instead of waiting for the next poll.
  const anyMore = !!runs && runs.some(r => r.more);
  useEffect(() => {
    if (!anyMore) return undefined;
    const timer = setTimeout(loadRuns, QUICK_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyMore, runs, loadRuns]);

  function start() {
    setStarting(true);
    setError('');
    api.post(`${base}/runs`, runBody(options))
      .then(res => Promise.all([loadRuns(), loadPlan()]).then(() => setOpenId(res.data.id)))
      .catch(err => setError(errorText(err)))
      .finally(() => setStarting(false));
  }

  function act(run, request) {
    setBusyId(run.id);
    setError('');
    request()
      .then(() => Promise.all([loadRuns(), loadPlan()]))
      .catch(err => setError(errorText(err)))
      .finally(() => setBusyId(null));
  }

  return (
    <div>
      {error && <p className={styles.errorText}>{error}</p>}
      <PlanPanel plan={plan} options={options} onOptions={setOptions} onStart={start} starting={starting} />

      <h4 className={styles.sectionTitle}>Runs</h4>
      {runs === null && <p className={styles.muted}>Loading...</p>}
      {runs !== null && runs.length === 0 && <p className={styles.empty}>No runs yet.</p>}
      {(runs || []).map(run => (
        <div key={run.id}>
          <RunCard
            run={run}
            open={openId === run.id}
            busy={busyId === run.id}
            onToggle={() => setOpenId(openId === run.id ? null : run.id)}
            onCancel={() => act(run, () => api.post(`${base}/runs/${run.id}/cancel`))}
            onRetry={() => act(run, () => api.post(`${base}/runs/${run.id}/retry`))}
            onDelete={() => act(run, () => api.delete(`${base}/runs/${run.id}`))}
          />
          {openId === run.id && <RunDetail api={api} projectId={projectId} run={run} />}
        </div>
      ))}
    </div>
  );
}

export default CofoldTab;

// MSA (CPU) tab: shows what a run of AlphaPulldown's feature search would be
// for the selected project (how many proteins, what it asks Slurm for),
// starts it, and follows each run - progress, failed proteins, logs. All of
// it goes through this module's own /alphapulldown routes; the backend talks
// to the Slurm module. Only ever touches core through the coreApi prop.
import React, { useCallback, useEffect, useState } from 'react';
import LogViewer from './LogViewer';
import { formatDuration } from './formatDuration';
import { errorText, badgeClass as badgeClassFor, formatWhen } from './runUi';
import styles from '../styles/MsaTab.module.css';

const POLL_MS = 10000;
const LOG_POLL_MS = 5000;

function badgeClass(state) {
  return badgeClassFor(styles, state);
}

function formatGB(memMB) {
  const gb = memMB / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb).toLocaleString()} GB`;
}

function runSeconds(run) {
  if (!run.startedAt) return null;
  const end = run.endedAt ? new Date(run.endedAt) : new Date();
  return Math.max(0, Math.round((end - new Date(run.startedAt)) / 1000));
}

function PlanPanel({ plan, redo, onRedo, onStart, starting }) {
  if (!plan) return <div className={styles.panel}>Loading...</div>;
  const r = plan.resources;
  const blocked = plan.problems.length > 0 || plan.toDo === 0 || !!plan.activeRun;
  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>New run</h4>
      {plan.problems.map(text => <p key={text} className={styles.warning}>{text}</p>)}
      {plan.proteins > 0 && (
        <>
          <p className={styles.summary}>
            <strong>{plan.proteins.toLocaleString()}</strong>
            {` proteins: ${plan.alreadyDone.toLocaleString()} already have features, `}
            <strong>{plan.toDo.toLocaleString()}</strong>
            {' to search.'}
          </p>
          {plan.toDo > 0 && (
            <p className={styles.summary}>
              {`One Slurm job searches ${r.parallel} protein${r.parallel === 1 ? '' : 's'} at a time (${r.rounds} round${r.rounds === 1 ? '' : 's'}) `}
              {`and asks for ${r.cpus.toLocaleString()} CPUs, ${formatGB(r.memMB)} memory and up to ${r.time}`}
              {r.partition ? ` on partition ${r.partition}.` : ' on the cluster default partition.'}
              {plan.method === 'mmseqs2' ? ' Searches use the public MMseqs2 server.' : ''}
            </p>
          )}
        </>
      )}
      {plan.activeRun && <p className={styles.warning}>A run for this project is still going (run {plan.activeRun.id}).</p>}
      {plan.toDo === 0 && plan.proteins > 0 && plan.problems.length === 0 && (
        <p className={styles.hint}>Every protein already has its features - the next tab can start.</p>
      )}
      <div className={styles.controls}>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={redo} onChange={e => onRedo(e.target.checked)} />
          <span>Search again, even for proteins that already have features</span>
        </label>
        <button type="button" className={styles.btnGreen} onClick={onStart} disabled={blocked || starting}>
          {starting ? 'Submitting...' : 'Run'}
        </button>
      </div>
      {plan.scripts && (
        <details className={styles.scripts}>
          <summary>Show the scripts that will run</summary>
          {Object.entries(plan.scripts).map(([name, text]) => (
            <div key={name}>
              <div className={styles.scriptName}>{name}</div>
              <pre className={styles.pre}>{text}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function RunCard({ run, open, onToggle, onCancel, onDelete, busy }) {
  const done = run.progress.searched + run.progress.skipped;
  const percent = run.total > 0 ? Math.min(100, Math.round((done / run.total) * 100)) : 0;
  const seconds = runSeconds(run);
  return (
    <div className={styles.runCard}>
      <div className={styles.runHeader}>
        <strong>{`Run ${run.id}`}</strong>
        <span className={`${styles.badge} ${badgeClass(run.state)}`}>{run.state}</span>
        {run.slurmJobId && <span className={styles.muted}>{`Slurm job ${run.slurmJobId}`}</span>}
        <span className={styles.spacer} />
        <button type="button" className={styles.btnBlue} onClick={onToggle}>{open ? 'Hide details' : 'Details'}</button>
        {run.active && <button type="button" className={styles.btnRed} onClick={onCancel} disabled={busy}>Cancel</button>}
        {!run.active && <button type="button" className={styles.btnGray} onClick={onDelete} disabled={busy}>Delete</button>}
      </div>
      <div className={styles.bar}><div className={styles.barFill} style={{ width: `${percent}%` }} /></div>
      <div className={styles.runMeta}>
        {`${done.toLocaleString()} of ${run.total.toLocaleString()} done`}
        {run.progress.skipped > 0 ? ` (${run.progress.skipped.toLocaleString()} already had features)` : ''}
        {run.progress.failed > 0 && <span className={styles.failedText}>{`, ${run.progress.failed.toLocaleString()} failed`}</span>}
        {` · started ${formatWhen(run.startedAt || run.createdAt)}`}
        {seconds !== null ? ` · ${run.active ? 'running for' : 'took'} ${formatDuration(seconds)}` : ''}
      </div>
      {run.statusError && <div className={styles.warning}>{`Could not refresh the state from Slurm: ${run.statusError}`}</div>}
    </div>
  );
}

function RunDetail({ api, projectId, run }) {
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState('slurm.out');
  const [protein, setProtein] = useState('');
  const [log, setLog] = useState({ text: '', truncated: false });
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/alphapulldown/projects/${projectId}/msa/runs/${run.id}`)
      .then(res => setDetail(res.data))
      .catch(err => setError(errorText(err)));
  }, [api, projectId, run.id, run.state, run.progress.searched, run.progress.failed]);

  const loadLog = useCallback(() => {
    const params = file === 'protein' ? { file, index: protein } : { file };
    if (file === 'protein' && !protein) return Promise.resolve();
    return api.get(`/alphapulldown/projects/${projectId}/msa/runs/${run.id}/log`, { params })
      .then(res => setLog(res.data))
      .catch(err => setError(errorText(err)));
  }, [api, projectId, run.id, file, protein]);

  useEffect(() => {
    loadLog();
    if (!run.active) return undefined;
    const timer = setInterval(loadLog, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [loadLog, run.active]);

  const failed = detail ? detail.failed : [];
  return (
    <div className={styles.detail}>
      {error && <p className={styles.errorText}>{error}</p>}
      {failed.length > 0 && (
        <>
          <h4 className={styles.panelTitle}>Proteins that failed</h4>
          <table className={styles.table}>
            <thead><tr><th>Protein</th><th className={styles.numeric}>Length</th><th>Result</th><th className={styles.numeric}>Seconds</th><th /></tr></thead>
            <tbody>
              {failed.map(f => (
                <tr key={f.index}>
                  <td className={styles.mono}>{f.name}</td>
                  <td className={styles.numeric}>{`${f.length.toLocaleString()} aa`}</td>
                  <td>{f.status === 'oom' ? 'Out of memory (killed)' : `Failed (exit ${f.exit})`}</td>
                  <td className={styles.numeric}>{f.seconds.toLocaleString()}</td>
                  <td><button type="button" className={styles.btnGray} onClick={() => { setProtein(String(f.index)); setFile('protein'); }}>Log</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className={styles.controls}>
        <span>Log:</span>
        <select className={styles.select} value={file} onChange={e => setFile(e.target.value)}>
          <option value="slurm.out">Job output (slurm.out)</option>
          <option value="slurm.err">Job errors (slurm.err)</option>
          {protein && <option value="protein">{`Protein ${protein} search`}</option>}
        </select>
        {log.truncated && <span className={styles.muted}>Showing the last 64 KB</span>}
      </div>
      <LogViewer text={log.text} />
    </div>
  );
}

function MsaTab({ coreApi, project, onChanged }) {
  const { api } = coreApi;
  const projectId = project.id;
  const [plan, setPlan] = useState(null);
  const [redo, setRedo] = useState(false);
  const [runs, setRuns] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const loadPlan = useCallback(() => api.get(`/alphapulldown/projects/${projectId}/msa/plan`, { params: { redo: redo ? 1 : 0 } })
    .then(res => setPlan(res.data))
    .catch(err => setError(errorText(err))), [api, projectId, redo]);

  const loadRuns = useCallback(() => api.get(`/alphapulldown/projects/${projectId}/msa/runs`)
    .then(res => {
      setRuns(res.data.runs);
      // Finished runs add their timings to the speed database, which changes the estimates.
      if (res.data.ingestedNow > 0) onChanged();
    })
    .catch(err => setError(errorText(err))), [api, projectId, onChanged]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setPlan(null);
    setRuns(null);
    setOpenId(null);
    setError('');
  }, [projectId]);

  useEffect(() => { loadPlan(); }, [loadPlan]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const anyActive = !!runs && runs.some(r => r.active);
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = setInterval(() => { loadRuns(); loadPlan(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, loadRuns, loadPlan]);

  function start() {
    setStarting(true);
    setError('');
    api.post(`/alphapulldown/projects/${projectId}/msa/runs`, { redo })
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

  const base = `/alphapulldown/projects/${projectId}/msa/runs`;
  return (
    <div>
      {error && <p className={styles.errorText}>{error}</p>}
      <PlanPanel plan={plan} redo={redo} onRedo={setRedo} onStart={start} starting={starting} />

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
            onCancel={() => act(run, () => api.post(`${base}/${run.id}/cancel`))}
            onDelete={() => act(run, () => api.delete(`${base}/${run.id}`))}
          />
          {openId === run.id && <RunDetail api={api} projectId={projectId} run={run} />}
        </div>
      ))}
    </div>
  );
}

export default MsaTab;

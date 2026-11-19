// Results tab: every completed prediction of the selected project with the
// scores AlphaFold 3 gave it, sorted best first (ipTM). The scores were read
// once from each job's summary file by the backend, so sorting, filtering and
// paging happen in the database. The best model and its summary file can be
// downloaded per complex, and the whole table as CSV. Only ever touches core
// through the coreApi prop; all calls go to this module's own /alphapulldown
// routes.
import React, { useCallback, useEffect, useState } from 'react';
import { errorText } from './runUi';
import styles from '../styles/MsaTab.module.css';
import own from '../styles/ResultsTab.module.css';

const PAGE = 50;
const FILTER_DELAY_MS = 350;

// The direction a column reads best-first in: interface PAE and the names
// ascending, every score descending (the server uses the same).
function defaultDir(key) {
  return key === 'pae' || key === 'bait' || key === 'cand' ? 'asc' : 'desc';
}

// [sort key, label, hint]. pae is better when LOW, the rest when high.
const COLUMNS = [
  ['iptm', 'ipTM', 'Interface predicted TM-score: how confident AlphaFold 3 is in the relative placement of the chains. Above 0.8 is a confident complex, below 0.6 usually a failed one.'],
  ['ptm', 'pTM', 'Predicted TM-score of the whole complex.'],
  ['ranking', 'Ranking score', 'AlphaFold 3\'s ranking score: it combines ipTM, pTM, disorder and clashes. The best of the seeds and samples is the model kept.'],
  ['pae', 'Interface PAE', 'The lowest predicted aligned error (Å) between two different chains. Lower is better.']
];

function downloadBlob(filename, blob) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

function fixed(value, digits) {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}

// ipTM bands as AlphaFold 3's own guidance reads them.
function iptmClass(value) {
  if (value === null || value === undefined) return '';
  if (value >= 0.8) return own.high;
  if (value >= 0.6) return own.medium;
  return own.low;
}

function ResultsTab({ coreApi, project }) {
  const { api } = coreApi;
  const projectId = project.id;
  const base = `/alphapulldown/projects/${projectId}`;
  const [sort, setSort] = useState('iptm');
  const [dir, setDir] = useState('');
  const [q, setQ] = useState('');
  const [minIptm, setMinIptm] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const params = useCallback(() => ({ sort, dir: dir || undefined, q: q || undefined, minIptm: minIptm === '' ? undefined : minIptm }), [sort, dir, q, minIptm]);

  const load = useCallback(() => api.get(`${base}/results`, { params: { ...params(), offset, limit: PAGE } })
    .then(res => { setData(res.data); setError(''); })
    .catch(err => setError(errorText(err))), [api, base, params, offset]);

  // A different project starts from a clean slate.
  useEffect(() => {
    setData(null);
    setOffset(0);
    setQ('');
    setMinIptm('');
    setError('');
  }, [projectId]);

  // Typing in a filter should not ask the server on every keystroke.
  useEffect(() => {
    const timer = setTimeout(load, FILTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [load]);

  function sortBy(key) {
    setOffset(0);
    if (key === sort) setDir(d => ((d || defaultDir(key)) === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir(''); }
  }

  function arrow(key) {
    if (key !== sort) return '';
    const effective = dir || defaultDir(key);
    return effective === 'asc' ? ' ▲' : ' ▼';
  }

  function download(item, file) {
    api.get(`${base}/results/${item.id}/download`, { params: { file }, responseType: 'blob' })
      .then(res => downloadBlob(`${item.bait}${item.cand ? `_${item.cand}` : ''}_${file === 'model' ? 'model.cif' : 'summary_confidences.json'}`, res.data))
      .catch(err => setError(err.message));
  }

  function exportCsv() {
    api.get(`${base}/results.csv`, { params: params(), responseType: 'blob' })
      .then(res => downloadBlob(`alphapulldown_P${project.project_number}_results.csv`, res.data))
      .catch(err => setError(err.message));
  }

  if (!data) return <div className={styles.panel}>{error ? <p className={styles.errorText}>{error}</p> : 'Loading...'}</div>;

  if (data.completed === 0) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>No prediction has completed in this project yet. Run the Prediction tab; each finished complex appears here with its scores.</p>
      </div>
    );
  }

  const pairLabel = project.mode === 'homo_oligomer' ? 'Protein' : 'Bait';
  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>Results</h4>
      {error && <p className={styles.errorText}>{error}</p>}
      <p className={styles.summary}>
        <strong>{data.completed.toLocaleString()}</strong>
        {` completed prediction${data.completed === 1 ? '' : 's'}`}
        {data.unscored > 0 ? `, ${data.unscored.toLocaleString()} without a readable score file` : ''}
        {'. Sorted by the column you click; ipTM is the usual first filter for a pulldown: '}
        <span className={own.high}>above 0.8</span>{' confident, '}
        <span className={own.medium}>0.6 to 0.8</span>{' uncertain, '}
        <span className={own.low}>below 0.6</span>{' unlikely to interact.'}
      </p>

      <div className={styles.controls}>
        <label>
          {'Name contains '}
          <input className={own.search} type="text" value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} />
        </label>
        <label>
          {'ipTM at least '}
          <input className={own.number} type="number" min="0" max="1" step="0.05" value={minIptm} onChange={e => { setMinIptm(e.target.value); setOffset(0); }} />
        </label>
        <span className={own.pager}>
          {`${data.total === 0 ? 0 : data.offset + 1}-${Math.min(data.total, data.offset + PAGE)} of ${data.total.toLocaleString()}`}
          <button type="button" className={styles.btnGray} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button type="button" className={styles.btnGray} disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </span>
        <button type="button" className={styles.btnBlue} onClick={exportCsv}>Download CSV</button>
      </div>

      {data.items.length === 0 ? <p className={styles.empty}>Nothing matches this filter.</p> : (
        <div className={own.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th><button type="button" className={own.sortButton} onClick={() => sortBy('bait')}>{`${pairLabel}${arrow('bait')}`}</button></th>
                <th><button type="button" className={own.sortButton} onClick={() => sortBy('cand')}>{`Candidate${arrow('cand')}`}</button></th>
                <th className={styles.numeric}><button type="button" className={own.sortButton} onClick={() => sortBy('length')}>{`Amino acids${arrow('length')}`}</button></th>
                {COLUMNS.map(([key, label, hint]) => (
                  <th key={key} className={styles.numeric} title={hint}>
                    <button type="button" className={own.sortButton} onClick={() => sortBy(key)}>{`${label}${arrow(key)}`}</button>
                  </th>
                ))}
                <th>Clash</th>
                <th>Files</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => (
                <tr key={item.id}>
                  <td className={styles.mono}>{item.bait}</td>
                  <td className={styles.mono}>{item.cand || '—'}</td>
                  <td className={styles.numeric}>{(item.lenA + (item.lenB || 0)).toLocaleString()}</td>
                  <td className={`${styles.numeric} ${iptmClass(item.iptm)}`}>{fixed(item.iptm, 2)}</td>
                  <td className={styles.numeric}>{fixed(item.ptm, 2)}</td>
                  <td className={styles.numeric}>{fixed(item.rankingScore, 2)}</td>
                  <td className={styles.numeric}>{item.interfacePaeMin === null ? '—' : `${item.interfacePaeMin.toFixed(1)} Å`}</td>
                  <td>{item.hasClash ? <span className={own.low}>yes</span> : (item.hasClash === false ? 'no' : '—')}</td>
                  <td className={own.files}>
                    <button type="button" className={styles.btnGray} onClick={() => download(item, 'model')}>Model (.cif)</button>
                    <button type="button" className={styles.btnGray} onClick={() => download(item, 'summary')}>Scores (.json)</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.hint}>
        {'Every prediction keeps all its seeds, samples and confidence files in its own job folder'}
        {data.folder ? <> under <span className={styles.mono}>{data.folder}</span></> : ''}
        {'. To browse them with PAE plots and interface scores, point '}
        <a href="https://github.com/KosinskiLab/aplit" target="_blank" rel="noopener noreferrer">APLit</a>
        {' (and AlphaJudge for the interface scores) at a job\'s output folder; they are not installed by this module. If you publish results, cite AlphaPulldown2 (doi:10.1093/bioinformatics/btaf115).'}
      </p>
    </div>
  );
}

export default ResultsTab;

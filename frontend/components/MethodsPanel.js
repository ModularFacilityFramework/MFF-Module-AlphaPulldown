// "Methods" for the selected project: a paragraph written from what its latest
// finished feature run and its latest prediction run recorded - which UniProt
// proteome release, which feature set, which software and database versions,
// which options - plus the citation. Facts that were not recorded are listed,
// not filled in.
import React, { useCallback, useEffect, useState } from 'react';
import styles from '../styles/MsaTab.module.css';

function MethodsPanel({ api, projectId, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.get(`/alphapulldown/projects/${projectId}/provenance`)
    .then(res => setData(res.data))
    .catch(err => setError(err.response?.data?.error || err.message)), [api, projectId]);

  useEffect(() => { setData(null); setError(''); load(); }, [load, refreshKey]);

  function copy() {
    if (!data || !navigator.clipboard) return;
    navigator.clipboard.writeText(data.methods).then(() => setCopied(true)).catch(() => {});
  }

  return (
    <details className={styles.scripts}>
      <summary>Methods text for this project (what was used, for a paper)</summary>
      {error && <p className={styles.errorText}>{error}</p>}
      {!data && !error && <p className={styles.muted}>Loading...</p>}
      {data && (
        <>
          <p className={styles.summary}>{data.methods}</p>
          {data.missing.map(text => <p key={text} className={styles.warning}>{text}</p>)}
          <button type="button" className={styles.btnBlue} onClick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
        </>
      )}
    </details>
  );
}

export default MethodsPanel;

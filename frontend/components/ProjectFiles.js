// The supporting files for AlphaPulldown, written into this project's folder
// in the user's workspace: FASTA for the feature (MSA) stage and protein
// lists. Written on demand, and again by the later stages; a file older than
// the last change to the selection is flagged as out of date.
import React, { useCallback, useEffect, useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

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

function ProjectFiles({ api, project, refreshKey }) {
  const [info, setInfo] = useState(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const base = `/alphapulldown/projects/${project.id}/files`;

  const load = useCallback(() => api.get(base)
    .then(res => { setInfo(res.data); setError(''); })
    .catch(err => setError(err.response?.data?.error || err.message)), [api, base]);

  useEffect(() => { load(); }, [load, refreshKey]);

  function write() {
    setWriting(true);
    setError('');
    api.post(base)
      .then(res => setInfo(res.data))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setWriting(false));
  }

  function download(name) {
    api.get(`${base}/${name}`, { responseType: 'blob' })
      .then(res => downloadBlob(name, res.data))
      .catch(err => setError(err.message));
  }

  const files = info ? info.files : [];
  const anyWritten = files.some(f => f.exists);
  const isStale = f => f.exists && info.projectUpdatedAt && new Date(f.modified) < new Date(info.projectUpdatedAt);

  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>Files for AlphaPulldown</h4>
      <p className={styles.hint}>
        FASTA files for the MSA stage and protein lists, written to your workspace. FASTA headers hold only the protein
        name, because AlphaPulldown names each protein&apos;s feature file after the header. Lists have one protein per
        line; a copy number above 1 is written as <span className={styles.mono}>name:2</span>.
      </p>
      {info && !info.workspace.active && (
        <p className={styles.warningBanner}>Your workspace storage isn&apos;t available, so files can&apos;t be written. Contact an administrator.</p>
      )}
      {info && info.dir && <p className={styles.muted}>{info.dir}</p>}
      <div className={styles.controls}>
        <button type="button" className={styles.btnGreen} onClick={write} disabled={writing || (info && !info.workspace.active)}>
          {writing ? 'Writing...' : (anyWritten ? 'Rewrite files' : 'Write files')}
        </button>
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
      {info && (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead><tr><th>File</th><th className={styles.numeric}>Size</th><th>Written</th><th /></tr></thead>
            <tbody>
              {files.map(f => (
                <tr key={f.name}>
                  <td className={styles.mono}>{f.name}</td>
                  <td className={styles.numeric}>{f.exists ? `${(f.size / 1024).toFixed(1)} KB` : '—'}</td>
                  <td>
                    {f.exists ? new Date(f.modified).toLocaleString() : <span className={styles.muted}>not written yet</span>}
                    {isStale(f) && <> <span className={`${styles.chip} ${styles.chipAmber}`}>out of date</span></>}
                  </td>
                  <td>{f.exists && <button type="button" className={styles.btnBlue} onClick={() => download(f.name)}>Download</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default ProjectFiles;

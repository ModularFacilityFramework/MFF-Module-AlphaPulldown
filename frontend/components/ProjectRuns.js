// The selected project's feature and co-folding runs, whoever started them, as
// last seen. Under the Project template: older runs that have no project.
import React, { useEffect, useState } from 'react';
import { useSortedRows, SortHeader } from '../utils/sortableTable';
import shared from '../styles/SequencesTab.module.css';

const KINDS = { msa_run: 'Feature (MSA)', cofold_run: 'Co-folding' };

function when(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '';
}

function ProjectRuns({ api, projectId }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setRuns(null);
    setError('');
    api.get(`/alphapulldown/projects/${projectId}/runs`)
      .then(res => { if (current) setRuns(res.data.runs || []); })
      .catch(err => { if (current) setError(err.response?.data?.error || err.message); });
    return () => { current = false; };
  }, [api, projectId]);

  const table = useSortedRows(runs || [], {
    kind: r => KINDS[r.kind] || r.kind,
    number: { value: r => r.id, type: 'number' },
    state: r => r.state,
    owner: r => r.ownerName,
    created: { value: r => r.createdAt, type: 'date' }
  }, { rememberAs: 'alphapulldown.target.runs' });

  if (error) return <p className={shared.errorText}>{error}</p>;
  if (!runs) return null;
  return (
    <div className={shared.panel}>
      <h3 className={shared.panelTitle}>{`Runs (${runs.length})`}</h3>
      {runs.length === 0 ? <p className={shared.empty}>No run yet.</p> : (
        <div className={shared.tableWrapper}>
          <table className={shared.table}>
            <thead><tr><SortHeader table={table} column="kind">Kind</SortHeader><SortHeader table={table} column="number" className={shared.numeric}>Run</SortHeader><SortHeader table={table} column="state">State</SortHeader><SortHeader table={table} column="owner">Started by</SortHeader><SortHeader table={table} column="created">Started</SortHeader></tr></thead>
            <tbody>
              {table.rows.map(r => (
                <tr key={`${r.kind}-${r.id}`}>
                  <td>{KINDS[r.kind] || r.kind}</td>
                  <td className={shared.numeric}>{r.id}</td>
                  <td>{r.state}</td>
                  <td>{r.ownerName}</td>
                  <td>{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default ProjectRuns;

// The project's chosen proteins: filter by list and text, change a protein's
// copy number, remove one or a whole list. Reloads when refreshKey changes
// (something was added elsewhere on this tab).
import React, { useCallback, useEffect, useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

const PAGE_SIZE = 50;

function SelectedSequences({ api, project, roles, refreshKey, onChanged }) {
  const [roleFilter, setRoleFilter] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ total: 0, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const base = `/alphapulldown/projects/${project.id}/sequences`;

  const load = useCallback(() => {
    setLoading(true);
    return api.get(base, { params: { role: roleFilter, q: text, page, limit: PAGE_SIZE } })
      .then(res => { setData(res.data); setError(''); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [api, base, roleFilter, text, page]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load, refreshKey]);

  // A different project starts from the first page, unfiltered.
  useEffect(() => {
    setRoleFilter('');
    setText('');
    setPage(1);
    setConfirmingClear(false);
  }, [project.id]);

  function run(request) {
    setError('');
    return request
      .then(() => { onChanged(); return load(); })
      .catch(err => setError(err.response?.data?.error || err.message));
  }

  function saveCopies(item, value) {
    const copies = Number(value);
    if (!Number.isInteger(copies) || copies < 1 || copies === item.copies) return;
    run(api.patch(`${base}/${item.id}`, { copies }));
  }

  function removeOne(item) {
    run(api.post(`${base}/remove`, { ids: [item.id] }));
  }

  function clearView() {
    setConfirmingClear(false);
    run(api.post(`${base}/remove`, roleFilter ? { role: roleFilter } : { all: true }));
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const roleLabel = key => (roles.find(r => r.key === key) || { label: key }).label;
  const clearLabel = roleFilter ? `all ${roleLabel(roleFilter).toLowerCase()}s` : 'everything';

  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>{`Selected sequences (${data.total.toLocaleString()}${roleFilter || text ? ' shown' : ''})`}</h4>
      <div className={styles.controls}>
        {roles.length > 1 && (
          <select className={styles.select} value={roleFilter} onChange={e => { setRoleFilter(e.target.value); setPage(1); setConfirmingClear(false); }}>
            <option value="">All lists</option>
            {roles.map(r => <option key={r.key} value={r.key}>{r.label}s</option>)}
          </select>
        )}
        <input
          className={styles.inputWide}
          type="text"
          placeholder="Filter by name or description"
          value={text}
          onChange={e => { setText(e.target.value); setPage(1); }}
        />
        {confirmingClear ? (
          <>
            <button type="button" className={styles.btnRed} onClick={clearView}>{`Really remove ${clearLabel}?`}</button>
            <button type="button" className={styles.btnGray} onClick={() => setConfirmingClear(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className={styles.btnGray} onClick={() => setConfirmingClear(true)} disabled={data.total === 0 && !roleFilter}>
            {`Remove ${clearLabel}`}
          </button>
        )}
      </div>
      {error && <p className={styles.errorText}>{error}</p>}

      {!loading && data.total === 0 ? (
        <p className={styles.empty}>No sequences yet - add some above.</p>
      ) : (
        <>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr><th>Name</th><th>Description</th><th>List</th><th className={styles.numeric}>Length</th><th>Copies</th><th /></tr>
              </thead>
              <tbody>
                {data.items.map(item => (
                  <tr key={item.id}>
                    <td className={styles.mono}>{item.name}</td>
                    <td>{item.description}</td>
                    <td><span className={`${styles.chip} ${item.role === 'bait' ? styles.chipBlue : ''}`}>{roleLabel(item.role)}</span></td>
                    <td className={styles.numeric}>{`${item.length.toLocaleString()} aa`}</td>
                    <td>
                      <input
                        key={`${item.id}-${item.copies}`}
                        className={styles.copiesInput}
                        type="number"
                        min="1"
                        max="50"
                        defaultValue={item.copies}
                        onBlur={e => saveCopies(item, e.target.value)}
                      />
                    </td>
                    <td><button type="button" className={styles.btnRed} onClick={() => removeOne(item)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pager}>
            <button type="button" className={styles.btnGray} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
            <span>{`Page ${page} of ${pages.toLocaleString()}`}</span>
            <button type="button" className={styles.btnGray} onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}

export default SelectedSequences;

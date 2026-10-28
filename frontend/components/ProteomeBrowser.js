// Whole-proteome source: find a proteome on UniProt, download it once into
// the user's workspace, then browse and filter it here and add chosen
// proteins - or everything matching the filter - to the project. Downloads
// run on the server; this component polls their progress.
import React, { useCallback, useEffect, useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

const PAGE_SIZE = 50;
const POLL_MS = 2000;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ProteomeBrowser({ api, onAdd, adding, targetLabel }) {
  const [local, setLocal] = useState({ workspace: { active: true }, local: [], downloads: [] });
  const [finderQuery, setFinderQuery] = useState('');
  const [reviewedOnly, setReviewedOnly] = useState(true);
  const [found, setFound] = useState(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(null); // { upid, reviewedOnly }
  const [filter, setFilter] = useState({ q: '', minLen: '', maxLen: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ total: 0, items: [] });
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [confirmingAll, setConfirmingAll] = useState(false);

  const loadLocal = useCallback(() => api.get('/alphapulldown/proteomes')
    .then(res => setLocal(res.data))
    .catch(err => setError(err.response?.data?.error || err.message)), [api]);

  useEffect(() => { loadLocal(); }, [loadLocal]);

  const downloading = local.downloads.some(d => d.state === 'downloading');
  useEffect(() => {
    if (!downloading) return undefined;
    const timer = setInterval(loadLocal, POLL_MS);
    return () => clearInterval(timer);
  }, [downloading, loadLocal]);

  // Browse page: refetch whenever the proteome, filter or page changes.
  // The filter is applied after a short pause so typing does not fire a
  // request per keystroke.
  useEffect(() => {
    if (!browsing) return undefined;
    setLoadingEntries(true);
    const timer = setTimeout(() => {
      api.get(`/alphapulldown/proteomes/${browsing.upid}/entries`, {
        params: {
          reviewedOnly: browsing.reviewedOnly ? 1 : 0, q: filter.q, minLen: filter.minLen, maxLen: filter.maxLen, page, limit: PAGE_SIZE
        }
      })
        .then(res => setData(res.data))
        .catch(err => setError(err.response?.data?.error || err.message))
        .finally(() => setLoadingEntries(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [api, browsing, filter, page]);

  function find(e) {
    e.preventDefault();
    if (!finderQuery.trim()) return;
    setFinding(true);
    setError('');
    api.get('/alphapulldown/uniprot/proteomes', { params: { q: finderQuery.trim() } })
      .then(res => setFound(res.data.results))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setFinding(false));
  }

  function download(upid) {
    setError('');
    api.post(`/alphapulldown/proteomes/${upid}/download`, { reviewedOnly })
      .then(loadLocal)
      .catch(err => setError(err.response?.data?.error || err.message));
  }

  function remove(item) {
    api.delete(`/alphapulldown/proteomes/${item.upid}`, { params: { reviewedOnly: item.reviewedOnly ? 1 : 0 } })
      .then(() => {
        if (browsing && browsing.upid === item.upid && browsing.reviewedOnly === item.reviewedOnly) setBrowsing(null);
        return loadLocal();
      })
      .catch(err => setError(err.response?.data?.error || err.message));
  }

  function browse(item) {
    setBrowsing({ upid: item.upid, reviewedOnly: item.reviewedOnly });
    setFilter({ q: '', minLen: '', maxLen: '' });
    setPage(1);
    setPicked(new Set());
    setConfirmingAll(false);
  }

  function updateFilter(field, value) {
    setFilter(f => ({ ...f, [field]: value }));
    setPage(1);
    setConfirmingAll(false);
  }

  function togglePicked(accession) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(accession)) next.delete(accession);
      else next.add(accession);
      return next;
    });
  }

  function togglePage() {
    setPicked(prev => {
      const next = new Set(prev);
      const allOnPage = data.items.every(i => next.has(i.accession));
      data.items.forEach(i => (allOnPage ? next.delete(i.accession) : next.add(i.accession)));
      return next;
    });
  }

  function addPicked() {
    onAdd({ source: 'proteome', upid: browsing.upid, reviewedOnly: browsing.reviewedOnly, accessions: [...picked] })
      .then(() => setPicked(new Set()));
  }

  function addAllMatching() {
    setConfirmingAll(false);
    onAdd({ source: 'proteome', upid: browsing.upid, reviewedOnly: browsing.reviewedOnly, filter });
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const allOnPagePicked = data.items.length > 0 && data.items.every(i => picked.has(i.accession));
  const activeDownloads = local.downloads.filter(d => d.state !== 'done');

  if (!local.workspace.active) {
    return <p className={styles.warningBanner}>Your workspace storage isn&apos;t available, so proteomes can&apos;t be downloaded. Contact an administrator.</p>;
  }

  return (
    <div>
      <h4 className={styles.sectionTitle}>Find a proteome on UniProt</h4>
      <form className={styles.controls} onSubmit={find}>
        <input
          className={styles.inputWide}
          type="text"
          placeholder="Organism name, taxon id or proteome id (UP...)"
          value={finderQuery}
          onChange={e => setFinderQuery(e.target.value)}
        />
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={reviewedOnly} onChange={e => setReviewedOnly(e.target.checked)} />
          <span>Download reviewed (Swiss-Prot) entries only</span>
        </label>
        <button type="submit" className={styles.btnBlue} disabled={finding || !finderQuery.trim()}>
          {finding ? 'Searching...' : 'Search'}
        </button>
      </form>
      {error && <p className={styles.errorText}>{error}</p>}
      {found && found.length === 0 && <p className={styles.empty}>No proteomes found.</p>}
      {found && found.length > 0 && (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead><tr><th>Proteome</th><th>Organism</th><th>Taxon</th><th className={styles.numeric}>Proteins</th><th /></tr></thead>
            <tbody>
              {found.map(p => (
                <tr key={p.upid}>
                  <td className={styles.mono}>{p.upid}</td>
                  <td>{p.organism}</td>
                  <td>{p.taxId}</td>
                  <td className={styles.numeric}>{p.proteinCount.toLocaleString()}</td>
                  <td><button type="button" className={styles.btnGreen} onClick={() => download(p.upid)}>Download</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className={styles.sectionTitle}>Your downloaded proteomes</h4>
      {activeDownloads.map(d => (
        <p key={d.file} className={d.state === 'error' ? styles.errorText : styles.hint}>
          {d.state === 'downloading' ? `Downloading ${d.file}... ${formatBytes(d.bytes)}` : `${d.file} failed: ${d.error}`}
        </p>
      ))}
      {local.local.length === 0 ? (
        <p className={styles.empty}>None yet - search for a proteome above and download it.</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead><tr><th>Proteome</th><th>Content</th><th className={styles.numeric}>Size</th><th /></tr></thead>
            <tbody>
              {local.local.map(item => (
                <tr key={item.file}>
                  <td className={styles.mono}>{item.upid}</td>
                  <td>{item.reviewedOnly ? 'Reviewed only' : 'All entries'}</td>
                  <td className={styles.numeric}>{formatBytes(item.bytes)}</td>
                  <td>
                    <button type="button" className={styles.btnBlue} onClick={() => browse(item)}>Browse</button>
                    {' '}
                    <button type="button" className={styles.btnGray} onClick={() => remove(item)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {browsing && (
        <>
          <h4 className={styles.sectionTitle}>{`Browsing ${browsing.upid}${browsing.reviewedOnly ? ' (reviewed only)' : ''}`}</h4>
          <div className={styles.controls}>
            <input
              className={styles.inputWide}
              type="text"
              placeholder="Filter: accession, gene or description words"
              value={filter.q}
              onChange={e => updateFilter('q', e.target.value)}
            />
            <input className={styles.inputNarrow} type="number" min="0" placeholder="Min aa" value={filter.minLen} onChange={e => updateFilter('minLen', e.target.value)} />
            <input className={styles.inputNarrow} type="number" min="0" placeholder="Max aa" value={filter.maxLen} onChange={e => updateFilter('maxLen', e.target.value)} />
          </div>
          <div className={styles.controls}>
            <span>{loadingEntries ? 'Loading...' : `${data.total.toLocaleString()} proteins match`}</span>
            <button type="button" className={styles.btnGreen} onClick={addPicked} disabled={adding || picked.size === 0}>
              {`Add ${picked.size.toLocaleString()} selected ${targetLabel}`}
            </button>
            {confirmingAll ? (
              <>
                <button type="button" className={styles.btnRed} onClick={addAllMatching} disabled={adding}>
                  {`Really add all ${data.total.toLocaleString()} ${targetLabel}?`}
                </button>
                <button type="button" className={styles.btnGray} onClick={() => setConfirmingAll(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className={styles.btnBlue} onClick={() => setConfirmingAll(true)} disabled={adding || data.total === 0}>
                {`Add all ${data.total.toLocaleString()} matching`}
              </button>
            )}
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allOnPagePicked} onChange={togglePage} aria-label="Select this page" /></th>
                  <th>Accession</th><th>Gene</th><th>Description</th><th className={styles.numeric}>Length</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(item => (
                  <tr key={item.accession}>
                    <td><input type="checkbox" checked={picked.has(item.accession)} onChange={() => togglePicked(item.accession)} /></td>
                    <td className={styles.mono}>{item.accession}</td>
                    <td>{item.gene}</td>
                    <td>{item.description}</td>
                    <td className={styles.numeric}>{`${item.length.toLocaleString()} aa`}</td>
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

export default ProteomeBrowser;

// Whole-proteome source: browse and filter one of the proteomes in the shared
// library (added in the Library tab - one copy for everyone, nothing is
// downloaded per user) and add chosen proteins - or everything matching the
// filter - to the project. A protein added this way stays tied to that exact
// proteome version, so its features are shared and its runs can say which
// proteome they used.
import React, { useCallback, useEffect, useState } from 'react';
import { SortHeader, useSortedRows } from '../utils/sortableTable';
import styles from '../styles/SequencesTab.module.css';

const PAGE_SIZE = 50;

function ProteomeBrowser({ api, onAdd, adding, targetLabel }) {
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(null); // the library proteome being browsed
  const [filter, setFilter] = useState({ q: '', minLen: '', maxLen: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ total: 0, items: [] });
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [confirmingAll, setConfirmingAll] = useState(false);

  const loadLibrary = useCallback(() => api.get('/alphapulldown/library')
    .then(res => setLibrary(res.data))
    .catch(err => setError(err.response?.data?.error || err.message)), [api]);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // Browse page: refetch whenever the proteome, filter or page changes.
  // The filter is applied after a short pause so typing does not fire a
  // request per keystroke.
  useEffect(() => {
    if (!browsing) return undefined;
    setLoadingEntries(true);
    const timer = setTimeout(() => {
      api.get(`/alphapulldown/library/proteomes/${browsing.id}/entries`, {
        params: { q: filter.q, minLen: filter.minLen, maxLen: filter.maxLen, page, limit: PAGE_SIZE }
      })
        .then(res => setData(res.data))
        .catch(err => setError(err.response?.data?.error || err.message))
        .finally(() => setLoadingEntries(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [api, browsing, filter, page]);

  function browse(item) {
    setBrowsing(item);
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
    onAdd({ source: 'proteome', proteomeId: browsing.id, accessions: [...picked] })
      .then(() => setPicked(new Set()));
  }

  function addAllMatching() {
    setConfirmingAll(false);
    onAdd({ source: 'proteome', proteomeId: browsing.id, filter });
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const allOnPagePicked = data.items.length > 0 && data.items.every(i => picked.has(i.accession));

  const proteomeTable = useSortedRows(library ? library.proteomes : [], {
    organism: item => item.organism,
    upid: item => item.upid,
    release: { value: item => item.release, type: 'text' },
    content: item => (item.subset === 'reviewed' ? 'Reviewed only' : 'All entries'),
    sequences: { value: item => item.entries, type: 'number' }
  }, { rememberAs: 'alphapulldown.sequences.proteomes' });
  // The proteins come a page at a time: sorting orders the page shown.
  const entryTable = useSortedRows(data.items, {
    accession: item => item.accession,
    gene: item => item.gene,
    description: item => item.description,
    length: { value: item => item.length, type: 'number' }
  }, { rememberAs: 'alphapulldown.sequences.proteome-entries' });

  if (!library) return <p className={styles.empty}>{error || 'Loading...'}</p>;
  if (!library.configured) {
    return <p className={styles.warningBanner}>The shared library has no folder yet, so there are no proteomes to browse. Ask staff to set it up in Setup.</p>;
  }

  return (
    <div>
      <h4 className={styles.sectionTitle}>Proteomes in the shared library</h4>
      {error && <p className={styles.errorText}>{error}</p>}
      {library.proteomes.length === 0 ? (
        <p className={styles.empty}>The library holds no proteome yet - add one in the Library tab.</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead><tr><SortHeader table={proteomeTable} column="organism">Organism</SortHeader><SortHeader table={proteomeTable} column="upid">Proteome</SortHeader><SortHeader table={proteomeTable} column="release">UniProt release</SortHeader><SortHeader table={proteomeTable} column="content">Content</SortHeader><SortHeader table={proteomeTable} column="sequences" className={styles.numeric}>Sequences</SortHeader><th /></tr></thead>
            <tbody>
              {proteomeTable.rows.map(item => (
                <tr key={item.id}>
                  <td>{item.organism}</td>
                  <td className={styles.mono}>{item.upid}</td>
                  <td>{item.release}</td>
                  <td>{item.subset === 'reviewed' ? 'Reviewed only' : 'All entries'}</td>
                  <td className={styles.numeric}>{item.entries.toLocaleString()}</td>
                  <td><button type="button" className={styles.btnBlue} onClick={() => browse(item)}>Browse</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {browsing && (
        <>
          <h4 className={styles.sectionTitle}>{`Browsing ${browsing.organism} (${browsing.upid}, release ${browsing.release}${browsing.subset === 'reviewed' ? ', reviewed only' : ''})`}</h4>
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
                  <SortHeader table={entryTable} column="accession">Accession</SortHeader><SortHeader table={entryTable} column="gene">Gene</SortHeader><SortHeader table={entryTable} column="description">Description</SortHeader><SortHeader table={entryTable} column="length" className={styles.numeric}>Length</SortHeader>
                </tr>
              </thead>
              <tbody>
                {entryTable.rows.map(item => (
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

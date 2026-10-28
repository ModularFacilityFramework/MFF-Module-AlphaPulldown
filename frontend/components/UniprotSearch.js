// Add proteins from UniProt: search by gene/protein name (optionally within
// one organism), or paste a list of accessions. The backend fetches the
// sequences, so nothing but accessions travels from here.
import React, { useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

const ACCESSIONS_PER_REQUEST = 500;

function UniprotSearch({ api, onAdd, adding, targetLabel }) {
  const [mode, setMode] = useState('search');
  const [query, setQuery] = useState('');
  const [organism, setOrganism] = useState('');
  const [reviewedOnly, setReviewedOnly] = useState(true);
  const [results, setResults] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [accessionText, setAccessionText] = useState('');

  function search(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    api.get('/alphapulldown/uniprot/search', { params: { q: query.trim(), organism: organism.trim(), reviewed: reviewedOnly ? 1 : 0 } })
      .then(res => { setResults(res.data.results); setPicked(new Set()); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setSearching(false));
  }

  function toggle(accession) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(accession)) next.delete(accession);
      else next.add(accession);
      return next;
    });
  }

  function toggleAll() {
    setPicked(prev => (prev.size === results.length ? new Set() : new Set(results.map(r => r.accession))));
  }

  function addPicked() {
    onAdd({ source: 'uniprot', accessions: [...picked] });
  }

  const accessions = accessionText.split(/[\s,;]+/).filter(Boolean);

  function addAccessions() {
    const payloads = [];
    for (let i = 0; i < accessions.length; i += ACCESSIONS_PER_REQUEST) {
      payloads.push({ source: 'uniprot', accessions: accessions.slice(i, i + ACCESSIONS_PER_REQUEST) });
    }
    onAdd(payloads).then(() => setAccessionText(''));
  }

  return (
    <div>
      <div className={styles.controls}>
        <label className={styles.checkboxField}>
          <input type="radio" checked={mode === 'search'} onChange={() => setMode('search')} />
          <span>Search</span>
        </label>
        <label className={styles.checkboxField}>
          <input type="radio" checked={mode === 'accessions'} onChange={() => setMode('accessions')} />
          <span>Accession list</span>
        </label>
      </div>

      {mode === 'search' ? (
        <>
          <form className={styles.controls} onSubmit={search}>
            <input
              className={styles.inputWide}
              type="text"
              placeholder="Gene or protein name, e.g. rpoA"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <input
              className={styles.input}
              type="text"
              placeholder="Organism (name or taxon id, optional)"
              value={organism}
              onChange={e => setOrganism(e.target.value)}
            />
            <label className={styles.checkboxField}>
              <input type="checkbox" checked={reviewedOnly} onChange={e => setReviewedOnly(e.target.checked)} />
              <span>Reviewed (Swiss-Prot) only</span>
            </label>
            <button type="submit" className={styles.btnBlue} disabled={searching || !query.trim()}>
              {searching ? 'Searching...' : 'Search'}
            </button>
          </form>
          {error && <p className={styles.errorText}>{error}</p>}
          {results && results.length === 0 && <p className={styles.empty}>No matches.</p>}
          {results && results.length > 0 && (
            <>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th><input type="checkbox" checked={picked.size === results.length} onChange={toggleAll} aria-label="Select all" /></th>
                      <th>Accession</th><th>Gene</th><th>Protein</th><th>Organism</th><th className={styles.numeric}>Length</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(r => (
                      <tr key={r.accession}>
                        <td><input type="checkbox" checked={picked.has(r.accession)} onChange={() => toggle(r.accession)} /></td>
                        <td className={styles.mono}>{r.accession}</td>
                        <td>{r.gene}</td>
                        <td>{r.name}</td>
                        <td>{r.organism}</td>
                        <td className={styles.numeric}>{r.length ? `${r.length.toLocaleString()} aa` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className={styles.btnGreen} onClick={addPicked} disabled={adding || picked.size === 0}>
                {adding ? 'Adding...' : `Add ${picked.size} selected ${targetLabel}`}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p className={styles.hint}>UniProt accessions separated by spaces, commas or new lines (e.g. P78344 Q8I2G6).</p>
          <textarea
            className={styles.textarea}
            value={accessionText}
            onChange={e => setAccessionText(e.target.value)}
            placeholder="P78344&#10;P0A7Z4"
            spellCheck={false}
          />
          <div className={styles.controls}>
            <button type="button" className={styles.btnGreen} onClick={addAccessions} disabled={adding || accessions.length === 0}>
              {adding ? 'Fetching...' : `Fetch and add ${accessions.length.toLocaleString()} ${targetLabel}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default UniprotSearch;

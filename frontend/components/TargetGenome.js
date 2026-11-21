// The genome (source organism) of the target: the UniProt proteome the chains
// should come from, and that the baits will later be picked from. The user
// may propose one (a name, a taxon id or a proteome id) and the app searches;
// the app can also suggest the organisms of the chains' UniProt entries. The
// user chooses.
import React, { useState } from 'react';
import { usePageState } from '../utils/pageState';
import shared from '../styles/SequencesTab.module.css';
import styles from '../styles/TargetTab.module.css';

function describeLibrary(held) {
  if (!held || held.length === 0) return 'not in the shared library yet';
  return `in the shared library (${held.map(h => `${h.release}, ${h.subset}`).join('; ')})`;
}

function TargetGenome({ api, stateKey, genome, chains, readOnly, needsLibrary, onChoose, onAddToLibrary, onCheckAgain, addingToLibrary, libraryMessage }) {
  const [text, setText] = usePageState(`${stateKey}:genome-search`, '');
  const [results, setResults] = useState(null);
  const [via, setVia] = useState('search');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function find(query, source, label) {
    setBusy(true);
    setError('');
    return api.get('/alphapulldown/target/genomes', { params: { q: query } })
      .then(res => { setResults({ label, items: res.data.results }); setVia(source); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setBusy(false));
  }

  function search(e) {
    e.preventDefault();
    if (text.trim()) find(text.trim(), /^UP\d{9}$/i.test(text.trim()) ? 'upid' : 'search', `Matches for "${text.trim()}"`);
  }

  // The organisms of the chains started from a UniProt ID.
  const taxa = [...new Set(chains.map(c => c.info && c.info.taxId).filter(Boolean))];

  function suggest() {
    if (taxa.length === 0) return;
    find(String(taxa[0]), 'suggestion', `Proteomes of the organism of your UniProt chain${taxa.length > 1 ? 's (first organism shown)' : ''}`);
  }

  function choose(item) {
    onChoose({ upid: item.upid, organism: item.organism, taxId: item.taxId, input: text.trim(), via });
    setResults(null);
  }

  return (
    <div>
      {genome ? (
        <div className={styles.genomeCard}>
          <strong>{genome.organism}</strong>
          {` - proteome ${genome.upid}, taxon ${genome.taxId}`}
          {genome.proteomeType ? `, ${genome.proteomeType.toLowerCase()}` : ''}
          {genome.genomeAssembly && genome.genomeAssembly.id ? `, genome assembly ${genome.genomeAssembly.id}` : ''}
          {genome.chosenAt ? ` (chosen ${new Date(genome.chosenAt).toLocaleDateString('en-GB')})` : ''}
        </div>
      ) : (
        <p className={shared.hint}>No genome chosen yet. Chains can only be confirmed as coming from a genome once you choose one.</p>
      )}

      {!readOnly && (
        <>
          <form className={shared.controls} onSubmit={search}>
            <input
              className={shared.inputWide}
              type="text"
              placeholder="Organism name, taxon id or proteome id (UP...)"
              value={text}
              onChange={e => setText(e.target.value)}
            />
            <button type="submit" className={shared.btnBlue} disabled={busy || !text.trim()}>{busy ? 'Searching...' : 'Search genomes'}</button>
            {taxa.length > 0 && (
              <button type="button" className={shared.btnGray} onClick={suggest} disabled={busy}>Suggest from my chains</button>
            )}
          </form>
          {error && <p className={shared.errorText}>{error}</p>}
          {results && (
            <div className={shared.tableWrapper}>
              <p className={shared.muted}>{results.label}</p>
              {results.items.length === 0 ? <p className={shared.empty}>No proteome found.</p> : (
                <table className={shared.table}>
                  <thead><tr><th /><th>Proteome</th><th>Organism</th><th>Taxon</th><th className={shared.numeric}>Proteins</th><th>Shared library</th></tr></thead>
                  <tbody>
                    {results.items.map(item => (
                      <tr key={item.upid}>
                        <td><button type="button" className={shared.btnGreen} onClick={() => choose(item)}>Use</button></td>
                        <td className={shared.mono}>{item.upid}</td>
                        <td>{item.organism}</td>
                        <td>{item.taxId}</td>
                        <td className={shared.numeric}>{item.proteinCount.toLocaleString('en-GB')}</td>
                        <td>{describeLibrary(item.inLibrary)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {needsLibrary && genome && (
        <div className={shared.warningBanner}>
          <span>
            {`Your own sequences can only be checked against ${genome.upid} once that proteome is in the shared library.`}
          </span>
          {!readOnly && (
            <div className={shared.controls}>
              <button type="button" className={shared.btnBlue} onClick={onAddToLibrary} disabled={addingToLibrary}>
                {addingToLibrary ? 'Starting...' : 'Add it to the library'}
              </button>
              <button type="button" className={shared.btnGray} onClick={onCheckAgain}>Check again</button>
              {libraryMessage && <span>{libraryMessage}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TargetGenome;

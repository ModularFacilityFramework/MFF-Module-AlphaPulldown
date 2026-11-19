// One chain of the target: where it starts (a UniProt ID or the user's own
// sequence), the sequence box (what is in it IS what is used - a sequence
// pulled from UniProt lands here so it can be edited, e.g. to drop a signal
// peptide), copies, and what the check against the genome said.
import React, { useState } from 'react';
import shared from '../styles/SequencesTab.module.css';
import styles from '../styles/TargetTab.module.css';

const STATUS_WORDS = {
  matched: { text: 'Confirmed in the genome', className: styles.statusMatched },
  not_matched: { text: 'Not found in the genome', className: styles.statusNotMatched },
  not_checked: { text: 'Not checked', className: styles.statusNotChecked }
};

function cleanedLength(text) {
  const body = text.includes('>') ? text.split(/\r?\n/).filter(l => !l.startsWith('>')).join('') : text;
  return body.replace(/\s+/g, '').replace(/\*/g, '').length;
}

function TargetChain({ api, chain, index, count, readOnly, onChange, onRemove }) {
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const accession = chain.accession.trim().toUpperCase();
  const info = chain.info && chain.info.accession === accession ? chain.info : null;
  const length = cleanedLength(chain.sequence);
  const original = info ? info.sequence : null;
  const differs = !!original && chain.sequence.replace(/\s+/g, '').toUpperCase() !== original;
  // The check result belongs to the saved version of this chain only.
  const unchanged = chain.saved && chain.saved.sequence === chain.sequence && chain.saved.accession === (chain.origin === 'uniprot' ? accession : null);
  const validation = unchanged ? chain.saved.validation : null;
  const verdict = validation ? STATUS_WORDS[validation.status] : null;

  function lookup(code) {
    const wanted = String(code || accession).trim().toUpperCase();
    if (!wanted) return;
    setLookupBusy(true);
    setLookupError('');
    api.get(`/alphapulldown/uniprot/entry/${encodeURIComponent(wanted)}`)
      .then(res => onChange({ accession: wanted, info: res.data, sequence: res.data.sequence, label: chain.label || res.data.gene || wanted }))
      .catch(err => setLookupError(err.response?.data?.error || err.message))
      .finally(() => setLookupBusy(false));
  }

  function search(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setLookupError('');
    api.get('/alphapulldown/uniprot/search', { params: { q: query.trim(), reviewed: 1 } })
      .then(res => setResults(res.data.results))
      .catch(err => setLookupError(err.response?.data?.error || err.message))
      .finally(() => setSearching(false));
  }

  function pick(result) {
    setResults(null);
    setQuery('');
    lookup(result.accession);
  }

  function removeSignal() {
    onChange({ sequence: original.slice(info.signalPeptide.end) });
  }

  function readFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(text => onChange({ sequence: text })).catch(err => setLookupError(`Could not read the file: ${err.message}`));
    e.target.value = '';
  }

  return (
    <div className={styles.chainCard}>
      <div className={styles.chainHeader}>
        <span className={styles.chainNumber}>{`Chain ${index + 1}`}</span>
        <input
          className={shared.input}
          type="text"
          placeholder="Name"
          value={chain.label}
          maxLength={100}
          disabled={readOnly}
          onChange={e => onChange({ label: e.target.value })}
          aria-label={`Name of chain ${index + 1}`}
        />
        <label className={shared.checkboxField}>
          <span>Copies</span>
          <input
            className={shared.inputNarrow}
            type="number"
            min={1}
            max={24}
            value={chain.copies}
            disabled={readOnly}
            onChange={e => onChange({ copies: e.target.value })}
          />
        </label>
        {!readOnly && (
          <>
            <label className={shared.checkboxField}>
              <input type="radio" checked={chain.origin === 'uniprot'} onChange={() => onChange({ origin: 'uniprot' })} />
              <span>From a UniProt ID</span>
            </label>
            <label className={shared.checkboxField}>
              <input type="radio" checked={chain.origin === 'sequence'} onChange={() => onChange({ origin: 'sequence', info: null })} />
              <span>My own sequence</span>
            </label>
          </>
        )}
        <span className={styles.spacer} />
        {!readOnly && count > 1 && <button type="button" className={shared.btnGray} onClick={onRemove}>Remove chain</button>}
      </div>

      {chain.origin === 'uniprot' && !readOnly && (
        <>
          <div className={styles.lookup}>
            <input
              className={shared.input}
              type="text"
              placeholder="UniProt accession, e.g. P0AEX9"
              value={chain.accession}
              onChange={e => onChange({ accession: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }}
              aria-label={`UniProt accession of chain ${index + 1}`}
            />
            <button type="button" className={shared.btnBlue} onClick={() => lookup()} disabled={lookupBusy || !accession}>
              {lookupBusy ? 'Fetching...' : 'Fetch sequence'}
            </button>
            <span className={shared.muted}>or search</span>
            <form onSubmit={search} className={styles.lookup}>
              <input className={shared.input} type="text" placeholder="Gene or protein name" value={query} onChange={e => setQuery(e.target.value)} />
              <button type="submit" className={shared.btnGray} disabled={searching || !query.trim()}>{searching ? 'Searching...' : 'Search UniProt'}</button>
            </form>
          </div>
          {results && (
            <div className={styles.searchResults}>
              {results.length === 0 && <div className={styles.searchRow}>No matches.</div>}
              {results.map(r => (
                <div key={r.accession} className={styles.searchRow}>
                  <button type="button" className={shared.btnGreen} onClick={() => pick(r)}>Use</button>
                  <span className={shared.mono}>{r.accession}</span>
                  <span>{[r.gene, r.name, r.organism, r.length ? `${r.length} aa` : ''].filter(Boolean).join(' - ')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {chain.origin === 'uniprot' && readOnly && <p className={styles.entryInfo}>{`UniProt ${chain.accession}`}</p>}
      {lookupError && <p className={shared.errorText}>{lookupError}</p>}

      {info && (
        <p className={styles.entryInfo}>
          {[
            info.name,
            info.gene && `gene ${info.gene}`,
            info.organism && `${info.organism}${info.taxId ? ` (taxon ${info.taxId})` : ''}`,
            info.release && `UniProt release ${info.release}${info.releaseDate ? `, ${info.releaseDate}` : ''}`,
            info.reviewed === false && 'unreviewed'
          ].filter(Boolean).join(' - ')}
        </p>
      )}

      <textarea
        className={styles.sequenceBox}
        value={chain.sequence}
        readOnly={readOnly}
        onChange={e => onChange({ sequence: e.target.value })}
        placeholder={chain.origin === 'uniprot' ? 'The UniProt sequence appears here, ready to edit.' : 'Paste the sequence or FASTA here.'}
        spellCheck={false}
        aria-label={`Sequence of chain ${index + 1}`}
      />
      <div className={styles.sequenceMeta}>
        <span>{`${length.toLocaleString('en-GB')} residues`}</span>
        {differs && <span className={styles.edited}>Edited from the UniProt sequence - what is in this box is what is used.</span>}
        {!readOnly && differs && <button type="button" className={shared.btnGray} onClick={() => onChange({ sequence: original })}>Reset to UniProt</button>}
        {!readOnly && info && info.signalPeptide && !differs && (
          <button type="button" className={shared.btnGray} onClick={removeSignal}>
            {`Remove signal peptide (residues ${info.signalPeptide.start}-${info.signalPeptide.end})`}
          </button>
        )}
        {!readOnly && <label>Load FASTA file <input type="file" accept=".fa,.fasta,.faa,.txt" onChange={readFile} /></label>}
      </div>
      {chain.saved && chain.saved.editSummary && unchanged && <p className={styles.verdict}>{`Edit recorded: ${chain.saved.editSummary}.`}</p>}
      {verdict && (
        <p className={styles.verdict}>
          <strong className={verdict.className}>{verdict.text}. </strong>
          {validation.detail}
        </p>
      )}
      {!verdict && chain.saved && <p className={styles.verdict}>Changed since it was last saved and checked.</p>}
    </div>
  );
}

export default TargetChain;

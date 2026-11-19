// Library tab: the proteomes every MFF-core user shares - one copy per
// UniProt release, never one per user - and the feature sets built from them.
// Everyone can look, search UniProt and add a proteome (a repeat of one the
// library already holds costs nothing); staff can remove one. Each row says
// exactly what the files are, so a job that used them can be described in a
// methods section. Only ever touches core through the coreApi prop.
import React, { useCallback, useEffect, useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

const POLL_MS = 2000;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function day(value) {
  return value ? String(value).slice(0, 10) : '';
}

function FeatureSets({ sets }) {
  if (sets.length === 0) return <p className={styles.hint}>No features built from this proteome yet. They are built the first time a project that uses it runs the Features tab.</p>;
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr><th>Feature set</th><th className={styles.numeric}>Proteins</th><th>Template cut-off</th><th>Built with</th><th>Databases</th></tr>
        </thead>
        <tbody>
          {sets.map(set => {
            const sw = set.environment && set.environment.software;
            return (
              <tr key={set.id}>
                <td className={styles.mono}>{set.key}</td>
                <td className={styles.numeric}>{set.features.toLocaleString()}</td>
                <td>{set.maxTemplateDate}</td>
                <td>
                  {sw
                    ? `AlphaPulldown ${sw.alphapulldown}, AlphaFold 3 ${sw.alphafold3 || '?'}, JAX ${sw.jax || '?'} (${day(set.environment.capturedAt)})`
                    : 'Not recorded yet (the first job records it)'}
                </td>
                <td>
                  {set.environment
                    ? set.environment.databases.map(d => `${d.name}${d.modified ? ` (${d.modified})` : ''}`).join('; ')
                    : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProteomeDetails({ p }) {
  const rows = [
    ['UniProt proteome', `${p.upid}${p.proteomeType ? ` (${p.proteomeType})` : ''}`],
    ['Organism', `${p.organism}${p.taxId ? `, taxon ${p.taxId}` : ''}${p.strain ? `, strain ${p.strain}` : ''}`],
    ['UniProt release', `${p.release}${p.releaseDate ? `, released ${p.releaseDate}` : ''}`],
    ['Content', p.subset === 'reviewed' ? 'Reviewed (Swiss-Prot) entries only' : 'All entries (Swiss-Prot and TrEMBL)'],
    ['Sequences', p.entries.toLocaleString()],
    ['Genome assembly', p.genomeAssembly ? `${p.genomeAssembly.id} (${p.genomeAssembly.level}, ${p.genomeAssembly.source})` : 'not given'],
    ['BUSCO completeness', p.busco ? `${p.busco.score}% (${p.busco.complete} of ${p.busco.total}, ${p.busco.lineage})` : 'not given'],
    ['Source', p.source],
    ['Downloaded', day(p.downloadedAt)],
    ['File', `${formatBytes(p.bytes)}, SHA-256 ${p.sha256}`]
  ];
  return (
    <table className={styles.table}>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}><td>{label}</td><td className={label === 'File' ? styles.mono : undefined}>{value}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function LibraryTab({ coreApi }) {
  const { api, useAuth, useRoles } = coreApi;
  const { canManageUsers } = useRoles(useAuth().userData);
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [reviewedOnly, setReviewedOnly] = useState(true);
  const [found, setFound] = useState(null);
  const [finding, setFinding] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(() => api.get('/alphapulldown/library')
    .then(res => setLibrary(res.data))
    .catch(err => setError(err.response?.data?.error || err.message)), [api]);

  useEffect(() => { load(); }, [load]);

  const downloading = !!library && library.downloads.some(d => d.state === 'downloading');
  useEffect(() => {
    if (!downloading) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [downloading, load]);

  function find(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setFinding(true);
    setError('');
    api.get('/alphapulldown/uniprot/proteomes', { params: { q: query.trim() } })
      .then(res => setFound(res.data.results))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setFinding(false));
  }

  function add(upid) {
    setError('');
    api.post('/alphapulldown/library/proteomes', { upid, reviewedOnly })
      .then(load)
      .catch(err => setError(err.response?.data?.error || err.message));
  }

  function remove(p) {
    setError('');
    api.delete(`/alphapulldown/library/proteomes/${p.id}`)
      .then(() => { setOpen(null); return load(); })
      .catch(err => setError(err.response?.data?.error || err.message));
  }

  if (!library) return <div className={styles.empty}>{error || 'Loading...'}</div>;

  if (!library.configured) {
    return (
      <p className={styles.warningBanner}>
        The shared library has no folder yet.
        {canManageUsers ? ' Set it in the Setup tab (Shared library).' : ' Ask staff to set it up.'}
      </p>
    );
  }

  const running = library.downloads.filter(d => d.state !== 'done');

  return (
    <div>
      <p className={styles.hint}>
        {'One copy of each UniProt reference proteome, shared by everyone, with the features built from it. '}
        {'A new UniProt release is added next to the old one, never over it. Folder: '}
        <span className={styles.mono}>{library.libraryDir}</span>
      </p>
      {error && <p className={styles.errorText}>{error}</p>}

      <h4 className={styles.sectionTitle}>Add a proteome from UniProt</h4>
      <form className={styles.controls} onSubmit={find}>
        <input
          className={styles.inputWide}
          type="text"
          placeholder="Organism name, taxon id or proteome id (UP...)"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={reviewedOnly} onChange={e => setReviewedOnly(e.target.checked)} />
          <span>Reviewed (Swiss-Prot) entries only</span>
        </label>
        <button type="submit" className={styles.btnBlue} disabled={finding || !query.trim()}>{finding ? 'Searching...' : 'Search'}</button>
      </form>
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
                  <td><button type="button" className={styles.btnGreen} onClick={() => add(p.upid)}>Add to library</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {running.map(d => (
        <p key={d.key} className={d.state === 'error' ? styles.errorText : styles.hint}>
          {d.state === 'downloading'
            ? `Adding ${d.upid} (${d.subset})${d.release ? `, release ${d.release}` : ''}... ${formatBytes(d.bytes)}`
            : `${d.upid} (${d.subset}) failed: ${d.error}`}
        </p>
      ))}

      <h4 className={styles.sectionTitle}>In the library</h4>
      {library.proteomes.length === 0 ? (
        <p className={styles.empty}>Nothing yet - search for a proteome above and add it.</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Organism</th><th>Proteome</th><th>UniProt release</th><th>Content</th>
                <th className={styles.numeric}>Sequences</th><th>Added</th><th>Feature sets</th><th />
              </tr>
            </thead>
            <tbody>
              {library.proteomes.map(p => (
                <React.Fragment key={p.id}>
                  <tr>
                    <td>{p.organism}</td>
                    <td className={styles.mono}>{p.upid}</td>
                    <td>{`${p.release}${p.releaseDate ? ` (${p.releaseDate})` : ''}`}</td>
                    <td>{p.subset === 'reviewed' ? 'Reviewed only' : 'All entries'}</td>
                    <td className={styles.numeric}>{p.entries.toLocaleString()}</td>
                    <td>{day(p.downloadedAt)}</td>
                    <td>{p.featureSets.length}</td>
                    <td>
                      <button type="button" className={styles.btnBlue} onClick={() => setOpen(open === p.id ? null : p.id)}>
                        {open === p.id ? 'Hide' : 'Details'}
                      </button>
                      {canManageUsers && (
                        <>
                          {' '}
                          <button type="button" className={styles.btnGray} onClick={() => remove(p)} disabled={p.projectProteins > 0} title={p.projectProteins > 0 ? `${p.projectProteins} protein(s) in projects use it` : 'Remove from the library'}>
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {open === p.id && (
                    <tr>
                      <td colSpan={8}>
                        <ProteomeDetails p={p} />
                        <h4 className={styles.sectionTitle}>Feature sets</h4>
                        <FeatureSets sets={p.featureSets} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default LibraryTab;

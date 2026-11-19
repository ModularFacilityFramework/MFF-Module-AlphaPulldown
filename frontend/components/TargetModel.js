// The 3D model of the target (optional). Its source is a PDB entry, the
// AlphaFold Protein Structure Database (both fetched online), a model the
// user predicted with ABCFold, or any mmCIF/PDB file. The model's chains are
// read out and compared with the target's chains, the user looks at the
// match and accepts it (or removes the model). It is not used for structure
// prediction at first - target and baits are co-folded.
import React, { useState } from 'react';
import shared from '../styles/SequencesTab.module.css';
import styles from '../styles/TargetTab.module.css';

const STATUS_WORDS = {
  exact: 'identical',
  contained: 'the chain is part of the model chain',
  extended: 'the model chain is shorter than the chain (partial model)',
  similar: 'similar, with differences',
  none: 'no match in the model'
};

function when(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '';
}

function TargetModel({ api, projectId, canChange, model, firstAccession, readOnly, onPayload }) {
  const [pdbId, setPdbId] = useState('');
  const [afAccession, setAfAccession] = useState('');
  const [uploadSource, setUploadSource] = useState('upload');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  function run(label, request) {
    setBusy(label);
    setError('');
    return request()
      .then(res => { onPayload(res.data); setReplacing(false); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setBusy(''));
  }

  const base = `/alphapulldown/projects/${projectId}/target/model`;

  function upload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    run('upload', async () => {
      const text = await file.text();
      return api.post(`${base}/upload`, text, {
        params: { filename: file.name, source: uploadSource },
        headers: { 'Content-Type': 'text/plain' },
        maxBodyLength: Infinity
      });
    });
  }

  const showForms = !model || replacing;

  return (
    <div>
      {model && (
        <div className={styles.genomeCard}>
          <div>
            <strong>{`${model.sourceLabel}${model.modelId ? ` ${model.modelId}` : ''}${model.version ? `, version ${model.version}` : ''}`}</strong>
            {model.filename ? ` - file ${model.filename}` : ''}
            {model.state === 'accepted'
              ? <span className={`${shared.chip} ${shared.chipGreen}`}> accepted {when(model.acceptedAt)}</span>
              : <span className={`${shared.chip} ${shared.chipAmber}`}> waiting for your check</span>}
          </div>
          <div className={shared.muted}>
            {[model.title, model.method, `obtained ${when(model.fetchedAt)}`, model.format === 'pdb' ? 'PDB format' : 'mmCIF', `SHA-256 ${model.sha256.slice(0, 12)}...`].filter(Boolean).join(' - ')}
          </div>
        </div>
      )}

      {model && (
        <div className={shared.tableWrapper}>
          <table className={shared.table}>
            <thead><tr><th>Target chain</th><th>Model chain</th><th>How they match</th><th className={shared.numeric}>Identity</th><th className={shared.numeric}>Coverage</th></tr></thead>
            <tbody>
              {model.mapping.map(m => (
                <tr key={m.chain}>
                  <td>{m.chain}</td>
                  <td>{m.modelChain || '-'}</td>
                  <td>{STATUS_WORDS[m.status] || m.status}</td>
                  <td className={shared.numeric}>{m.modelChain ? `${Math.round(m.identity * 1000) / 10}%` : ''}</td>
                  <td className={shared.numeric}>{m.modelChain ? `${Math.round(m.coverage * 1000) / 10}%` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={shared.muted}>
            {`The model holds ${model.chains.length} protein chain${model.chains.length === 1 ? '' : 's'}: ${model.chains.map(c => `${c.id} (${c.length} residues)`).join(', ')}. `}
            {model.covers ? 'It covers every chain of the target.' : 'It does not cover every chain of the target.'}
            {' It is kept with the target and is not used for structure prediction.'}
          </p>
        </div>
      )}

      {!readOnly && model && !replacing && (
        <div className={shared.controls}>
          {model.state !== 'accepted' && (
            <button type="button" className={shared.btnGreen} disabled={!canChange || !!busy} onClick={() => run('accept', () => api.post(`${base}/accept`, {}))}>
              Accept this model
            </button>
          )}
          <button type="button" className={shared.btnGray} disabled={!canChange || !!busy} onClick={() => setReplacing(true)}>Use another model</button>
          <button type="button" className={shared.btnRed} disabled={!canChange || !!busy} onClick={() => run('remove', () => api.delete(base))}>Remove model</button>
        </div>
      )}

      {!readOnly && showForms && (
        <>
          {!canChange && <p className={shared.hint}>Save the target first (including any changes to its chains); then add a model.</p>}
          <div className={shared.controls}>
            <input className={shared.input} type="text" placeholder="PDB entry, e.g. 1CRN" value={pdbId} maxLength={4} onChange={e => setPdbId(e.target.value)} />
            <button type="button" className={shared.btnBlue} disabled={!canChange || !!busy || !pdbId.trim()} onClick={() => run('pdb', () => api.post(`${base}/fetch`, { source: 'pdb', id: pdbId.trim() }))}>
              {busy === 'pdb' ? 'Fetching...' : 'Fetch from the PDB'}
            </button>
          </div>
          <div className={shared.controls}>
            <input className={shared.input} type="text" placeholder={firstAccession ? `UniProt accession, e.g. ${firstAccession}` : 'UniProt accession'} value={afAccession} onChange={e => setAfAccession(e.target.value)} />
            {firstAccession && !afAccession && <button type="button" className={shared.btnGray} onClick={() => setAfAccession(firstAccession)}>{`Use ${firstAccession}`}</button>}
            <button type="button" className={shared.btnBlue} disabled={!canChange || !!busy || !afAccession.trim()} onClick={() => run('af', () => api.post(`${base}/fetch`, { source: 'alphafold_db', id: afAccession.trim() }))}>
              {busy === 'af' ? 'Fetching...' : 'Fetch from AlphaFold DB'}
            </button>
          </div>
          <div className={shared.controls}>
            <select className={shared.select} value={uploadSource} onChange={e => setUploadSource(e.target.value)}>
              <option value="upload">A model file (mmCIF or PDB)</option>
              <option value="abcfold">A model predicted with ABCFold</option>
            </select>
            <label className={shared.btnGreen}>
              {busy === 'upload' ? 'Reading...' : 'Upload model'}
              <input type="file" accept=".cif,.mmcif,.pdb,.ent,.txt" onChange={upload} disabled={!canChange || !!busy} style={{ display: 'none' }} />
            </label>
            {replacing && <button type="button" className={shared.btnGray} onClick={() => setReplacing(false)}>Keep the current model</button>}
          </div>
        </>
      )}
      {error && <p className={shared.errorText}>{error}</p>}
    </div>
  );
}

export default TargetModel;

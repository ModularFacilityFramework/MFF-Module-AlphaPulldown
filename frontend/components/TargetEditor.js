// The Target tab for one target of a project: define the target (one chain or many), say
// which genome it comes from, optionally attach a 3D model, and confirm.
// Everything is saved as a draft whether or not it is validated; the Baits
// tab opens only once the target is confirmed. The owner edits; a developer
// or administrator opening someone else's target gets it read-only (the
// server decides - this component only follows `readOnly`).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import TargetChain from './TargetChain';
import TargetGenome from './TargetGenome';
import TargetModel from './TargetModel';
import { usePageDraft } from '../utils/pageState';
import shared from '../styles/SequencesTab.module.css';
import styles from '../styles/TargetTab.module.css';

const EVENT_WORDS = {
  saved: 'Saved',
  reopened: 'Reopened for editing (chains or genome changed)',
  checked_against_genome: 'Chains checked against the genome',
  chimera_acknowledged: 'Chimera warning acknowledged',
  confirmed: 'Confirmed',
  model_loaded: 'Model loaded',
  model_accepted: 'Model accepted',
  model_removed: 'Model removed'
};

function when(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '';
}

function normalizedAccession(chain) {
  return chain.origin === 'uniprot' ? chain.accession.trim().toUpperCase() : null;
}

function snapshotOf(draft) {
  return JSON.stringify({
    name: draft.name.trim(),
    chains: draft.chains.map(c => [c.origin, normalizedAccession(c), c.sequence, Number(c.copies) || 1, c.label.trim()]),
    genome: draft.genome ? draft.genome.upid : null
  });
}

let keyCounter = 0;
function newKey() {
  keyCounter += 1;
  return `chain-${keyCounter}`;
}

function blankChain() {
  return { key: newKey(), origin: 'uniprot', accession: '', sequence: '', copies: 1, label: '', info: null, saved: null };
}

function chainFromSaved(c) {
  return {
    key: newKey(),
    origin: c.origin,
    accession: c.accession || '',
    sequence: c.sequence,
    copies: c.copies,
    label: c.label,
    info: c.uniprot ? { ...c.uniprot, accession: c.accession, sequence: c.originalSequence } : null,
    saved: { accession: c.accession, sequence: c.sequence, validation: c.validation, editSummary: c.editSummary }
  };
}

function draftFrom(payload) {
  const target = payload.target;
  if (!target) return { name: payload.project.name, chains: [blankChain()], genome: null };
  return { name: target.name, chains: target.chains.map(chainFromSaved), genome: target.genome };
}

// targetId null = a new target that has not been saved yet.
function TargetEditor({ coreApi, projectId, targetId, onChanged, onSaved }) {
  const { api } = coreApi;
  const [payload, setPayload] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState('');
  const mounted = useRef(true);
  // Where this target's unsaved edits are remembered (per user, per target).
  const stateKey = `sp-target:${projectId}:${targetId || 'new'}`;
  const memory = usePageDraft(`${stateKey}:draft`);

  useEffect(() => {
    // Set again here: development builds run effects, clean them up, then run them again.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const apply = useCallback((data, created) => {
    const next = draftFrom(data);
    memory.forget(); // saved: nothing unsaved is left to remember
    setPayload(data);
    setDraft(next);
    setSaved(snapshotOf(next));
    setAcknowledged(false);
    if (created && onSaved) onSaved(data.target.id);
    else if (onChanged) onChanged();
  }, [onChanged, onSaved, memory]);

  useEffect(() => {
    setPayload(null);
    setDraft(null);
    setError('');
    // A new target starts blank; the project's own record gives its name
    // and the chimera warning text.
    const request = targetId
      ? api.get(`/alphapulldown/targets/${targetId}`)
      : api.get(`/alphapulldown/projects/${projectId}/targets`).then(res => ({
        data: { project: res.data.project, readOnly: res.data.readOnly, readOnlyReason: res.data.readOnlyReason, ownerName: '', target: null, chimeraWarning: res.data.chimeraWarning }
      }));
    request
      .then(res => {
        const next = draftFrom(res.data);
        const baseline = snapshotOf(next);
        // Unsaved edits the user left behind come back, but only when the
        // saved target they were made on has not changed since.
        const kept = res.data.readOnly ? null : memory.restore(baseline);
        let shown = next;
        if (kept && Array.isArray(kept.chains) && kept.chains.length > 0) {
          const restored = {
            name: String(kept.name || ''),
            chains: kept.chains.map(c => ({ ...c, key: newKey() })),
            genome: kept.genome || null
          };
          if (snapshotOf(restored) !== baseline) shown = restored;
        }
        setPayload(res.data);
        setDraft(shown);
        setSaved(baseline);
      })
      .catch(err => setError(err.response?.data?.error || err.message));
  }, [api, projectId, targetId, memory]);

  // Remember unsaved edits as they are made; forget them once saved or reverted.
  useEffect(() => {
    if (!payload || !draft || payload.readOnly) return;
    memory.remember(saved, { name: draft.name, chains: draft.chains, genome: draft.genome }, snapshotOf(draft) === saved);
  }, [payload, draft, saved, memory]);

  if (error && !payload) return <p className={shared.errorText}>{error}</p>;
  if (!payload || !draft) return <div className={shared.empty}>Loading...</div>;

  const readOnly = payload.readOnly;
  const target = payload.target;
  const dirty = snapshotOf(draft) !== saved;
  const base = target ? `/alphapulldown/targets/${target.id}` : null;
  const unsavedChains = draft.chains.filter(c => c.origin === 'uniprot' && c.accession.trim() && !c.sequence.trim()).length;

  function run(label, request, created = false) {
    setBusy(label);
    setError('');
    return request()
      .then(res => { apply(res.data, created); return res.data; })
      .catch(err => { setError(err.response?.data?.error || err.message); return null; })
      .finally(() => { if (mounted.current) setBusy(''); });
  }

  function changeChain(index, patch) {
    setDraft(prev => ({ ...prev, chains: prev.chains.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
  }

  function save() {
    const body = {
      name: draft.name.trim(),
      chains: draft.chains.map(c => ({
        origin: c.origin,
        accession: normalizedAccession(c) || undefined,
        sequence: c.sequence,
        copies: c.copies,
        label: c.label
      })),
      genome: draft.genome ? { upid: draft.genome.upid, input: draft.genome.input || '', via: draft.genome.via || 'search' } : null
    };
    if (target) run('save', () => api.put(base, body));
    else run('save', () => api.post(`/alphapulldown/projects/${projectId}/targets`, body), true);
  }

  function addToLibrary() {
    setBusy('library');
    setLibraryMessage('');
    api.post('/alphapulldown/library/proteomes', { upid: draft.genome.upid, reviewedOnly: false })
      .then(() => setLibraryMessage('Download started. It can take a few minutes; follow it in the Library tab, then press Check again.'))
      .catch(err => setLibraryMessage(err.response?.data?.error || err.message))
      .finally(() => setBusy(''));
  }

  const chimera = target ? target.chimera : null;
  const needsLibrary = !!target && target.chains.some(c => c.validation && c.validation.basis === 'library_missing');
  const canConfirm = !readOnly && !!target && !dirty && target.problems.length === 0 && (!chimera.flagged || acknowledged);
  const firstAccession = (target ? target.chains : []).map(c => c.accession).find(Boolean) || '';

  return (
    <div>
      {readOnly && (
        <div className={shared.warningBanner}>
          <span>{`Read-only${payload.ownerName ? ` (target made by ${payload.ownerName})` : ''}. ${payload.readOnlyReason || 'You cannot change this project.'}`}</span>
        </div>
      )}
      {payload.itemWarning && <p className={shared.errorText}>{payload.itemWarning}</p>}
      {!readOnly && payload.ownerName && <p className={shared.hint}>{`Made by ${payload.ownerName}. Everyone with write access to this project can change it.`}</p>}

      <div className={shared.panel}>
        <h3 className={shared.panelTitle}>
          {'Target '}
          {target ? (
            <span className={`${shared.chip} ${target.status === 'confirmed' ? shared.chipGreen : shared.chipAmber}`}>
              {target.status === 'confirmed' ? `confirmed ${when(target.confirmedAt)}` : 'draft - saved, not confirmed'}
            </span>
          ) : <span className={`${shared.chip} ${shared.chipAmber}`}>not saved yet</span>}
        </h3>
        <p className={shared.hint}>
          The protein or complex you are interested in: one chain or several. Start each chain from a UniProt ID or from your own sequence.
          The sequence in each box is exactly what is used, so edit it if you need to (for example to remove a signal peptide).
        </p>
        <div className={shared.controls}>
          <label className={shared.checkboxField}>
            <span>Target name</span>
            <input className={shared.inputWide} type="text" value={draft.name} maxLength={255} disabled={readOnly} onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))} />
          </label>
        </div>
        {draft.chains.map((chain, index) => (
          <TargetChain
            key={chain.key}
            api={api}
            chain={chain}
            index={index}
            count={draft.chains.length}
            readOnly={readOnly}
            onChange={patch => changeChain(index, patch)}
            onRemove={() => setDraft(prev => ({ ...prev, chains: prev.chains.filter((c, i) => i !== index) }))}
          />
        ))}
        {!readOnly && (
          <div className={shared.controls}>
            <button type="button" className={shared.btnBlue} disabled={draft.chains.length >= 20} onClick={() => setDraft(prev => ({ ...prev, chains: [...prev.chains, blankChain()] }))}>
              + Add a chain
            </button>
          </div>
        )}
      </div>

      <div className={shared.panel}>
        <h3 className={shared.panelTitle}>Genome (source organism)</h3>
        <p className={shared.hint}>
          Choose the proteome the target comes from. Each chain is checked against it, and the baits will be picked from it. A chain that cannot be
          confirmed in this genome is flagged.
        </p>
        <TargetGenome
          api={api}
          stateKey={stateKey}
          genome={draft.genome}
          chains={draft.chains}
          readOnly={readOnly}
          needsLibrary={needsLibrary}
          addingToLibrary={busy === 'library'}
          libraryMessage={libraryMessage}
          onChoose={genome => setDraft(prev => ({ ...prev, genome }))}
          onAddToLibrary={addToLibrary}
          onCheckAgain={() => run('check', () => api.post(`${base}/validate`, {}))}
        />
      </div>

      {!readOnly && (
        <div className={shared.controls}>
          <button type="button" className={shared.btnGreen} onClick={save} disabled={!!busy || (!dirty && !!target) || unsavedChains > 0 || draft.chains.some(c => !c.sequence.trim())}>
            {busy === 'save' ? 'Saving...' : 'Save target'}
          </button>
          {target && <button type="button" className={shared.btnGray} onClick={() => run('check', () => api.post(`${base}/validate`, {}))} disabled={!!busy || dirty}>Check against the genome again</button>}
          {dirty && <span className={shared.muted}>Unsaved changes. Saving also checks every chain against the genome.</span>}
          {!dirty && target && <span className={shared.muted}>{`Saved ${when(target.updatedAt)}. Checked ${when(target.validatedAt) || 'not yet'}.`}</span>}
        </div>
      )}
      {error && <p className={shared.errorText}>{error}</p>}

      <div className={shared.panel}>
        <h3 className={shared.panelTitle}>3D model of the target (optional)</h3>
        <p className={shared.hint}>
          A PDB entry, an AlphaFold database model, a model you ran with ABCFold, or your own file. It is checked against the chains and kept with the
          target, but it is not used for folding: the target and the baits are co-folded.
        </p>
        <TargetModel
          api={api}
          stateKey={stateKey}
          targetId={target ? target.id : null}
          canChange={!!target && !dirty}
          model={target ? target.model : null}
          firstAccession={firstAccession}
          readOnly={readOnly}
          onPayload={apply}
        />
      </div>

      <div className={shared.panel}>
        <h3 className={shared.panelTitle}>Confirm the target</h3>
        {target && target.status === 'confirmed' && (
          <p className={shared.hint}>
            {'The target is confirmed and the Baits tab is open. Changing its chains or genome and saving reopens it for confirmation.'}
          </p>
        )}
        {target && target.problems.length > 0 && (
          <ul className={shared.details}>{target.problems.map(p => <li key={p}>{p}</li>)}</ul>
        )}
        {target && chimera.flagged && (
          <div className={styles.chimera}>
            <p><strong>Chimeric complex.</strong></p>
            <p>{payload.chimeraWarning}</p>
            <p>{`Not confirmed in the genome: ${chimera.chains.join(', ')}.`}</p>
            {chimera.acknowledged ? (
              <p>{`Acknowledged ${when(chimera.acknowledged.at)} and recorded with the target.`}</p>
            ) : !readOnly && (
              <label className={shared.checkboxField}>
                <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} disabled={dirty} />
                <span>I understand this complex is chimeric and its results need a huge grain of salt. Go ahead.</span>
              </label>
            )}
          </div>
        )}
        {!readOnly && target && target.status !== 'confirmed' && (
          <div className={shared.controls}>
            <button
              type="button"
              className={shared.btnGreen}
              disabled={!canConfirm || !!busy}
              onClick={() => run('confirm', () => api.post(`${base}/confirm`, { acknowledgeChimera: acknowledged }))}
            >
              {busy === 'confirm' ? 'Confirming...' : 'Confirm target'}
            </button>
            {dirty && <span className={shared.muted}>Save your changes first.</span>}
          </div>
        )}
        {!target && <p className={shared.hint}>Save the target to be able to confirm it.</p>}
      </div>

      {target && (
        <div className={shared.panel}>
          <h3 className={shared.panelTitle}>Record for the methods</h3>
          <p className={styles.recordText}>{target.methods}</p>
          <details>
            <summary className={shared.muted}>{`History (${target.events.length})`}</summary>
            <ul className={styles.events}>
              {target.events.map(e => <li key={e.id}>{`${when(e.at)} - ${EVENT_WORDS[e.event] || e.event}`}</li>)}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

export default TargetEditor;

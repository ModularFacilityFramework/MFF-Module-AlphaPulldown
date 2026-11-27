// Target selector under the project bar: a project holds one or many targets.
// Choosing "New target" starts a blank draft that is saved from the Target tab.
import React, { useState } from 'react';
import shared from '../styles/SequencesTab.module.css';
import styles from '../styles/TargetTab.module.css';

export const NEW_TARGET = 'new';

function TargetBar({ targets, targetId, readOnly, canCreate, onSelect, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = typeof targetId === 'number' ? targets.find(t => t.id === targetId) : null;

  function remove() {
    setBusy(true);
    setError('');
    onDelete(current.id)
      .then(() => setConfirming(false))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setBusy(false));
  }

  return (
    <div className={`${shared.controls} ${styles.targetBar}`}>
      <label className={shared.checkboxField} htmlFor="alphapulldown-target">Target</label>
      <select
        id="alphapulldown-target"
        className={shared.select}
        value={targetId}
        onChange={e => { setConfirming(false); onSelect(e.target.value === NEW_TARGET ? NEW_TARGET : Number(e.target.value)); }}
      >
        {targets.map(t => <option key={t.id} value={t.id}>{`${t.name || `Target ${t.id}`} (${t.status})`}</option>)}
        {!readOnly && canCreate && <option value={NEW_TARGET}>+ New target</option>}
      </select>
      {current && (
        <span className={`${shared.chip} ${current.status === 'confirmed' ? shared.chipGreen : shared.chipAmber}`}>
          {current.status === 'confirmed' ? 'confirmed' : 'draft'}
        </span>
      )}
      {current && !readOnly && (confirming ? (
        <>
          <button type="button" className={shared.btnRed} onClick={remove} disabled={busy}>{busy ? 'Deleting...' : 'Really delete this target?'}</button>
          <button type="button" className={shared.btnGray} onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </>
      ) : <button type="button" className={shared.btnGray} onClick={() => setConfirming(true)}>Delete target</button>)}
      {error && <span className={shared.errorText}>{error}</span>}
    </div>
  );
}

export default TargetBar;

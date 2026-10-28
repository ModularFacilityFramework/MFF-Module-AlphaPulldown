// Project selector above the tab bar. A project owns one set of proteins and
// ties the Sequences, MSA and Co-folding tabs together. Creating and deleting
// are handed up (onCreate/onDelete return promises) so AlphaPulldownTab.js
// stays the single owner of the project list.
import React, { useState } from 'react';
import styles from '../styles/ProjectBar.module.css';

export const MODE_LABELS = {
  pulldown: 'Pulldown (baits vs candidates)',
  all_vs_all: 'All vs all',
  homo_oligomer: 'Homo-oligomer'
};

function ProjectBar({ projects, currentId, onSelect, onCreate, onDelete }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState('pulldown');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const current = projects.find(p => p.id === currentId) || null;

  function run(action) {
    setBusy(true);
    setError('');
    return action()
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setBusy(false));
  }

  function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give the project a name');
      return;
    }
    run(() => onCreate(name.trim(), mode).then(() => {
      setCreating(false);
      setName('');
      setMode('pulldown');
    }));
  }

  function handleDelete() {
    run(() => onDelete(current.id).then(() => setConfirmingDelete(false)));
  }

  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="alphapulldown-project">Project</label>
        <select
          id="alphapulldown-project"
          className={styles.select}
          value={currentId ?? ''}
          onChange={e => { setConfirmingDelete(false); onSelect(Number(e.target.value)); }}
          disabled={projects.length === 0}
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map(p => (
            <option key={p.id} value={p.id}>{`P${p.project_number} — ${p.name}`}</option>
          ))}
        </select>
        {current && <span className={styles.chip}>{MODE_LABELS[current.mode] || current.mode}</span>}
        {!creating && (
          <button type="button" className={styles.newButton} onClick={() => setCreating(true)}>+ New project</button>
        )}
        {current && !creating && (confirmingDelete ? (
          <>
            <button type="button" className={styles.dangerButton} onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting...' : `Really delete P${current.project_number}?`}
            </button>
            <button type="button" className={styles.neutralButton} onClick={() => setConfirmingDelete(false)} disabled={busy}>Cancel</button>
          </>
        ) : (
          <button type="button" className={styles.neutralButton} onClick={() => setConfirmingDelete(true)}>Delete</button>
        ))}
      </div>

      {creating && (
        <form className={styles.createForm} onSubmit={handleCreate}>
          <input
            type="text"
            className={styles.nameInput}
            placeholder="Project name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={255}
            autoFocus
          />
          <select className={styles.select} value={mode} onChange={e => setMode(e.target.value)}>
            {Object.entries(MODE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <button type="submit" className={styles.newButton} disabled={busy}>{busy ? 'Creating...' : 'Create'}</button>
          <button type="button" className={styles.neutralButton} onClick={() => { setCreating(false); setError(''); }} disabled={busy}>Cancel</button>
        </form>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}

export default ProjectBar;

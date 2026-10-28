// Sequences tab: choose a project's proteins (UniProt search, FASTA, a whole
// proteome), review the selection, and write the files AlphaPulldown reads.
// Adding goes through onAdd below, which sends one or several requests and
// shows what was added and what was skipped. Only ever touches core through
// the coreApi prop - see docs/MFF-Core_module-core-api.md for the contract.
import React, { useCallback, useEffect, useState } from 'react';
import UniprotSearch from './UniprotSearch';
import FastaInput from './FastaInput';
import ProteomeBrowser from './ProteomeBrowser';
import SelectedSequences from './SelectedSequences';
import ProjectFiles from './ProjectFiles';
import AddResultBanner from './AddResultBanner';
import styles from '../styles/SequencesTab.module.css';

const SUB_TABS = [
  { key: 'uniprot', label: 'UniProt search' },
  { key: 'fasta', label: 'Paste / upload FASTA' },
  { key: 'proteome', label: 'Proteome' }
];
const MAX_REPORTED = 100;

function rolesFor(mode) {
  return mode === 'pulldown'
    ? [{ key: 'bait', label: 'Bait' }, { key: 'candidate', label: 'Candidate' }]
    : [{ key: 'all', label: 'Protein' }];
}

function SequencesTab({ coreApi, project, onChanged }) {
  const { api } = coreApi;
  const roles = rolesFor(project.mode);
  const [subTab, setSubTab] = useState('uniprot');
  const [addAs, setAddAs] = useState(roles[0].key);
  const [result, setResult] = useState(null);
  const [adding, setAdding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // A different project (or mode) resets the target list and the last result.
  useEffect(() => {
    setAddAs(rolesFor(project.mode)[0].key);
    setResult(null);
  }, [project.id, project.mode]);

  // payloads: one request body or an array of them, sent one after another
  // and summed up. Resolves when done; failures are shown, not thrown.
  const onAdd = useCallback(async (payloads) => {
    const list = Array.isArray(payloads) ? payloads : [payloads];
    const total = { added: 0, skippedCount: 0, skipped: [] };
    setAdding(true);
    setResult(null);
    try {
      for (const payload of list) {
        const res = await api.post(`/alphapulldown/projects/${project.id}/sequences`, { ...payload, role: addAs });
        total.added += res.data.added;
        total.skippedCount += res.data.skippedCount;
        total.skipped.push(...res.data.skipped);
      }
      setResult({ ...total, skipped: total.skipped.slice(0, MAX_REPORTED) });
    } catch (err) {
      setResult({ ...total, skipped: total.skipped.slice(0, MAX_REPORTED), error: err.response?.data?.error || err.message });
    } finally {
      setAdding(false);
      setRefreshKey(k => k + 1);
      onChanged();
    }
  }, [api, project.id, addAs, onChanged]);

  const changed = useCallback(() => {
    setRefreshKey(k => k + 1);
    onChanged();
  }, [onChanged]);

  const targetLabel = roles.length > 1 ? `as ${roles.find(r => r.key === addAs).label.toLowerCase()}s` : 'to the list';

  return (
    <div>
      {roles.length > 1 && (
        <div className={styles.controls}>
          <label className={styles.checkboxField}>
            <span>Add new proteins as</span>
            <select className={styles.select} value={addAs} onChange={e => setAddAs(e.target.value)}>
              {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
        </div>
      )}

      <AddResultBanner result={result} onDismiss={() => setResult(null)} />

      <div className={styles.addPanel}>
        <div className={styles.subTabBar}>
          {SUB_TABS.map(tab => (
            <button
              key={tab.key}
              type="button"
              className={tab.key === subTab ? `${styles.subTab} ${styles.subTabActive}` : styles.subTab}
              onClick={() => setSubTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className={styles.subPanel}>
          {subTab === 'uniprot' && <UniprotSearch api={api} onAdd={onAdd} adding={adding} targetLabel={targetLabel} />}
          {subTab === 'fasta' && <FastaInput onAdd={onAdd} adding={adding} targetLabel={targetLabel} />}
          {subTab === 'proteome' && <ProteomeBrowser api={api} onAdd={onAdd} adding={adding} targetLabel={targetLabel} />}
        </div>
      </div>

      <SelectedSequences api={api} project={project} roles={roles} refreshKey={refreshKey} onChanged={changed} />
      <ProjectFiles api={api} project={project} refreshKey={refreshKey} />
    </div>
  );
}

export default SequencesTab;

// Run tab - collects one or more protein sequences and zero or more ligand
// SMILES/CCD entries, plus model selection, and runs the job: POST /alphapulldown/jobs
// creates AND submits to Slurm in one request, no separate draft/submit steps.
// Whatever's in the sbatch script preview box below - regenerated live as
// fields change, or hand-edited - is exactly what gets sent and run; there's
// no "was it edited" distinction anywhere in this module.
import React, { useEffect, useState } from 'react';
import styles from '../styles/RunTab.module.css';

// No RoseTTAFold3 entry - confirmed against the real, installed abcfold
// CLI's own --help (v1.1.2, "Tool to run & compare AlphaFold3, Boltz,
// Chai-1, OpenFold3 and Protenix") that it isn't a supported model at
// all; selecting it produced a guaranteed job failure ("unrecognized
// arguments: -r"). See abcfoldCommandBuilder.js's own comment.
const MODEL_LABELS = {
  alphafold3: 'AlphaFold3',
  boltz: 'Boltz',
  chai1: 'Chai-1',
  openfold3: 'OpenFold3',
  protenix: 'Protenix'
};

let nextEntryKey = 1;
function newProteinEntry() {
  return { key: nextEntryKey++, type: 'protein', id: '', sequence: '' };
}
function newLigandEntry() {
  return { key: nextEntryKey++, type: 'ligand', id: '', smiles: '', ccd: '' };
}

function RunTab({ coreApi, onJobCreated, prefill, prefillStatus, editingJobId }) {
  const { api } = coreApi;
  const [jobName, setJobName] = useState('');
  const [entries, setEntries] = useState([newProteinEntry()]);
  const [modelSeeds, setModelSeeds] = useState('1');
  const [models, setModels] = useState({
    alphafold3: true, boltz: true, chai1: true, openfold3: true, protenix: true
  });
  const [mmseqs2, setMmseqs2] = useState(true);
  const [templates, setTemplates] = useState(false);
  const [customTemplatePath, setCustomTemplatePath] = useState('');
  const [ligandSmilesAffinity, setLigandSmilesAffinity] = useState('');
  const [ligandCcdAffinity, setLigandCcdAffinity] = useState('');
  const [ligandChainAffinity, setLigandChainAffinity] = useState('');
  const [modelParamsPath, setModelParamsPath] = useState('');
  const [override, setOverride] = useState(true);
  const [noVisuals, setNoVisuals] = useState(false);
  const [noServer, setNoServer] = useState(true);
  const [gpuCount, setGpuCount] = useState(1);
  const [settingsWarning, setSettingsWarning] = useState('');
  const [workspaceActive, setWorkspaceActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scriptPreview, setScriptPreview] = useState('');
  // The exact input-JSON filename baked into scriptPreview's abcfoldCommand
  // line by the preview call that generated it - must travel with
  // scriptContent at submit time (POST /jobs), otherwise the backend would
  // mint a fresh, different filename for the actual file it writes to disk
  // while the (possibly several seconds older) script text still asks for
  // the one from this preview, and the job fails on the cluster looking
  // for a file that was never created under that name.
  const [inputJsonFilename, setInputJsonFilename] = useState('');
  // The actual AF3 input JSON text (not just its filename) - only needed
  // for the "Download files" button below, so a user can take the exact
  // submit.sh + input JSON this tab would submit and run/debug it by hand
  // outside this module entirely.
  const [inputJsonPreview, setInputJsonPreview] = useState('');
  // Guards only the live-refresh below from overwriting a manual edit
  // mid-typing - it has no bearing on what gets submitted. Whatever's in
  // scriptPreview at "Run job" time is sent, full stop, regardless of
  // this flag.
  const [previewEdited, setPreviewEdited] = useState(false);
  // Mirrors prefillStatus into local state so it can be dismissed (the
  // 'found' case) without the parent needing to track that too - null
  // means no restore was attempted (an ordinary fresh Run tab), 'found'
  // means fields below were just populated from a real job.json, 'not_found'
  // means a Resubmit/Clone was requested but this job predates saved
  // parameters (see AlphaPulldownTab.js's onEditJob/onCloneJob).
  const [restoreBanner, setRestoreBanner] = useState(null);

  useEffect(() => {
    api.get('/alphapulldown/settings').then(res => {
      const s = res.data;
      setMmseqs2(!!s.default_mmseqs2);
      setTemplates(!!s.default_templates);
      if (s.workspace && !s.workspace.active) {
        setWorkspaceActive(false);
        setSettingsWarning('Your workspace storage isn’t available, so AlphaPulldown jobs can’t be created — check the Setup tab.');
      }
    }).catch(() => {});
  }, [api]);

  // prefill: a job's own job.json (see alphapulldownRoutes.js's JOB_PARAMS_FILENAME),
  // handed down by AlphaPulldownTab.js after ResultsTab.js's Resubmit or Clone
  // action loads it - restores every field below to that job's own values,
  // ready to edit before running again. Only runs when prefillStatus is
  // 'found' - 'not_found' (the job predates saved parameters) deliberately
  // leaves every field untouched (there's nothing to restore) and just
  // raises restoreBanner instead; null (an ordinary fresh Run tab, no
  // restore attempted at all) does nothing here. Keyed on prefillStatus/
  // prefill's own identity (a fresh pair every time Resubmit/Clone fires,
  // see ResultsTab.js/AlphaPulldownTab.js), not on any one field of it, so it
  // only re-applies when a genuinely new prefill request comes in - not on
  // every keystroke afterwards, which would stomp whatever's being typed.
  useEffect(() => {
    if (prefillStatus === 'not_found') {
      setRestoreBanner('not_found');
      return;
    }
    if (prefillStatus !== 'found' || !prefill) return;
    setJobName(prefill.name || '');
    const restoredEntries = (prefill.sequences || []).map(s => (s.type === 'protein'
      ? { key: nextEntryKey++, type: 'protein', id: s.id || '', sequence: s.sequence || '' }
      : { key: nextEntryKey++, type: 'ligand', id: s.id || '', smiles: s.smiles || '', ccd: s.ccd || '' }));
    setEntries(restoredEntries.length > 0 ? restoredEntries : [newProteinEntry()]);
    setModelSeeds((prefill.modelSeeds && prefill.modelSeeds.length > 0 ? prefill.modelSeeds : [1]).join(','));
    const restoredModels = prefill.models || [];
    setModels(Object.keys(MODEL_LABELS).reduce((acc, key) => ({ ...acc, [key]: restoredModels.includes(key) }), {}));
    setMmseqs2(!!prefill.mmseqs2);
    setTemplates(!!prefill.templates);
    setCustomTemplatePath(prefill.customTemplatePath || '');
    setLigandSmilesAffinity(prefill.ligandSmiles || '');
    setLigandCcdAffinity(prefill.ligandCcd || '');
    setLigandChainAffinity(prefill.ligandChain || '');
    setModelParamsPath(prefill.modelParamsPath || '');
    setOverride(prefill.override !== undefined ? !!prefill.override : true);
    setNoVisuals(prefill.noVisuals !== undefined ? !!prefill.noVisuals : false);
    setNoServer(prefill.noServer !== undefined ? !!prefill.noServer : true);
    setGpuCount(prefill.gpuCount || 1);
    setPreviewEdited(false);
    setRestoreBanner('found');
  }, [prefillStatus, prefill]);

  function buildPayload() {
    return {
      name: jobName,
      sequences: entries.map(e => (e.type === 'protein'
        ? { type: 'protein', id: e.id, sequence: e.sequence }
        : { type: 'ligand', id: e.id, smiles: e.smiles || undefined, ccd: e.ccd || undefined })),
      modelSeeds: modelSeeds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)),
      models: Object.keys(models).filter(k => models[k]),
      mmseqs2,
      templates,
      customTemplatePath: customTemplatePath || undefined,
      ligandSmiles: ligandSmilesAffinity || undefined,
      ligandCcd: ligandCcdAffinity || undefined,
      ligandChain: ligandChainAffinity || undefined,
      modelParamsPath: modelParamsPath || undefined,
      override,
      noVisuals,
      noServer,
      gpuCount
    };
  }

  function refreshPreview() {
    return api.post('/alphapulldown/jobs/preview', buildPayload())
      .then(res => {
        setScriptPreview(res.data.sbatchScript);
        setInputJsonFilename(res.data.inputJsonFilename);
        setInputJsonPreview(res.data.inputJson);
      })
      .catch(() => {});
  }

  // Live preview: regenerate the sbatch script shortly after any field
  // changes - same debounced-refresh pattern already used by the Setup
  // tab's own preview. Skipped once the user has directly edited the box,
  // same as there too. Also skipped while the form doesn't even clear
  // buildJobArtifacts's own minimum bar (name + at least one entry id) -
  // without this, a blank/fresh mount (the default state, and what a
  // Resubmit/Clone with no saved parameters to restore leaves the form at)
  // fires a guaranteed-to-400 preview call every time, self-swallowed by
  // refreshPreview()'s own .catch(() => {}) but still a real, pointless
  // failed request on every single Run tab visit.
  useEffect(() => {
    if (previewEdited) return undefined;
    if (!jobName.trim() || entries.every(e => !e.id.trim())) return undefined;
    const timer = setTimeout(refreshPreview, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewEdited, jobName, entries, modelSeeds, models, mmseqs2, templates, customTemplatePath,
    ligandSmilesAffinity, ligandCcdAffinity, ligandChainAffinity, modelParamsPath, override, noVisuals, noServer, gpuCount
  ]);

  function updateEntry(key, field, value) {
    setEntries(list => list.map(e => (e.key === key ? { ...e, [field]: value } : e)));
  }
  function removeEntry(key) {
    setEntries(list => list.filter(e => e.key !== key));
  }
  function toggleModel(model) {
    setModels(m => ({ ...m, [model]: !m[model] }));
  }

  function validate() {
    if (!jobName.trim()) return 'Job name is required';
    if (entries.length === 0) return 'At least one sequence entry is required';
    for (const e of entries) {
      if (!e.id.trim()) return 'Every entry needs an id';
      if (e.type === 'protein' && !e.sequence.trim()) return `Entry ${e.id} needs a protein sequence`;
      if (e.type === 'ligand' && !e.smiles.trim() && !e.ccd.trim()) return `Entry ${e.id} needs a SMILES string or CCD code`;
    }
    if (Object.values(models).every(v => !v)) return 'At least one model must be selected';
    return '';
  }

  function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setSubmitting(true);

    // scriptPreview is sent unconditionally - whatever's in the box right
    // now (live-generated, or hand-edited) is what runs. No "was it
    // edited" check anywhere. inputJsonFilename must travel alongside it -
    // see its own declaration above for why.
    const payload = {
      ...buildPayload(),
      scriptContent: scriptPreview || undefined,
      inputJsonFilename: scriptPreview ? inputJsonFilename : undefined
    };

    // editingJobId set (Resubmit, from ResultsTab.js) means this is the
    // same job running again in its own existing workDir - POST to it
    // directly. Unset (a plain new job, or Clone) always goes through
    // POST /jobs, which creates its own new job/workDir regardless of
    // whether the fields on screen came from a clone's prefill.
    const request = editingJobId
      ? api.post(`/alphapulldown/jobs/${editingJobId}/submit`, payload)
      : api.post('/alphapulldown/jobs', payload);

    request
      .then(() => onJobCreated())
      .catch(err => setError(err.response?.data?.message || err.response?.data?.error || err.message))
      .finally(() => setSubmitting(false));
  }

  // Lets someone take the exact submit.sh + input JSON this tab would
  // submit and run/debug it by hand directly on the cluster, outside this
  // module entirely - same content that would actually be submitted
  // (scriptPreview, whether freshly generated or hand-edited), not a
  // separate re-generation that could drift from it.
  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  function downloadFiles() {
    downloadTextFile('submit.sh', scriptPreview);
    downloadTextFile(inputJsonFilename || 'input.json', inputJsonPreview);
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {editingJobId && (
        <p className={styles.hint}>
          Editing job {editingJobId} — Resubmit runs it again in its own folder (which gets cleared
          first), overwriting its previous attempt.
        </p>
      )}
      {restoreBanner === 'found' && (
        <div className={styles.restoreConfirm}>
          <span>Parameters restored from this job&apos;s last run.</span>
          <button type="button" onClick={() => setRestoreBanner(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {restoreBanner === 'not_found' && (
        <p className={styles.warning}>
          Couldn&apos;t find saved parameters for this job — fill in the form manually.
        </p>
      )}
      {settingsWarning && <p className={styles.warning}>{settingsWarning}</p>}
      <p className={styles.hint}>
        Partition is picked automatically from this cluster&apos;s real GPU partitions (see the Setup tab);
        CPUs, memory, and wall time use this module&apos;s own configured resource request, also editable
        there. GRES scales with the GPU count you choose below. Your account and notification email are
        pulled automatically, from your core account.
      </p>

      <label className={styles.field}>
        <span>Job name</span>
        <input type="text" value={jobName} onChange={e => setJobName(e.target.value)} />
      </label>

      <label className={styles.field}>
        <span>GPU count</span>
        <input
          type="number"
          min="1"
          value={gpuCount}
          onChange={e => setGpuCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
        />
      </label>

      <h4 className={styles.sectionTitle}>Sequences</h4>
      {entries.map(entry => (
        <div key={entry.key} className={styles.entryRow}>
          <select value={entry.type} onChange={e => setEntries(list => list.map(x => (x.key === entry.key
            ? (e.target.value === 'protein' ? { ...newProteinEntry(), key: entry.key, id: entry.id } : { ...newLigandEntry(), key: entry.key, id: entry.id })
            : x)))}
          >
            <option value="protein">Protein</option>
            <option value="ligand">Ligand</option>
          </select>
          <input
            className={styles.idInput}
            type="text"
            placeholder="id (e.g. A)"
            value={entry.id}
            onChange={e => updateEntry(entry.key, 'id', e.target.value)}
          />
          {entry.type === 'protein' ? (
            <textarea
              className={styles.sequenceInput}
              placeholder="Protein sequence"
              value={entry.sequence}
              onChange={e => updateEntry(entry.key, 'sequence', e.target.value)}
            />
          ) : (
            <div className={styles.ligandInputs}>
              <input
                type="text"
                placeholder="SMILES string"
                value={entry.smiles}
                onChange={e => updateEntry(entry.key, 'smiles', e.target.value)}
              />
              <input
                type="text"
                placeholder="or CCD code"
                value={entry.ccd}
                onChange={e => updateEntry(entry.key, 'ccd', e.target.value)}
              />
            </div>
          )}
          <button type="button" className={styles.removeButton} onClick={() => removeEntry(entry.key)}>Remove</button>
        </div>
      ))}
      <div className={styles.addButtons}>
        <button type="button" className={styles.addButton} onClick={() => setEntries(list => [...list, newProteinEntry()])}>+ Protein</button>
        <button type="button" className={styles.addButton} onClick={() => setEntries(list => [...list, newLigandEntry()])}>+ Ligand</button>
      </div>

      <label className={styles.field}>
        <span>Model seeds (comma-separated)</span>
        <input type="text" value={modelSeeds} onChange={e => setModelSeeds(e.target.value)} />
      </label>

      <h4 className={styles.sectionTitle}>Models (at least one required)</h4>
      <div className={styles.checkboxRow}>
        {Object.entries(MODEL_LABELS).map(([key, label]) => (
          <label key={key} className={styles.checkboxField}>
            <input type="checkbox" checked={!!models[key]} onChange={() => toggleModel(key)} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <h4 className={styles.sectionTitle}>MSA &amp; templates</h4>
      <div className={styles.checkboxRow}>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={mmseqs2} onChange={e => setMmseqs2(e.target.checked)} />
          <span>Use MMseqs2</span>
        </label>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={templates} onChange={e => setTemplates(e.target.checked)} />
          <span>Use templates</span>
        </label>
      </div>
      <label className={styles.field}>
        <span>Custom template path (optional)</span>
        <input type="text" value={customTemplatePath} onChange={e => setCustomTemplatePath(e.target.value)} />
      </label>

      <h4 className={styles.sectionTitle}>Ligand affinity scoring (Boltz-2, optional)</h4>
      <p className={styles.hint}>
        This is separate from the structure-prediction ligands entered above — it enables Boltz-2 affinity
        scoring for one specific ligand via the abcfold CLI&apos;s --ligand_smiles/--ligand_ccd/--ligand_chain flags.
      </p>
      <div className={styles.affinityRow}>
        <input type="text" placeholder="SMILES" value={ligandSmilesAffinity} onChange={e => setLigandSmilesAffinity(e.target.value)} />
        <input type="text" placeholder="or CCD code" value={ligandCcdAffinity} onChange={e => setLigandCcdAffinity(e.target.value)} />
        <input type="text" placeholder="Chain (optional)" value={ligandChainAffinity} onChange={e => setLigandChainAffinity(e.target.value)} />
      </div>

      <h4 className={styles.sectionTitle}>Advanced</h4>
      <label className={styles.field}>
        <span>Model params path (optional)</span>
        <input type="text" value={modelParamsPath} onChange={e => setModelParamsPath(e.target.value)} />
      </label>
      <div className={styles.checkboxRow}>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
          <span>Override existing output</span>
        </label>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={noVisuals} onChange={e => setNoVisuals(e.target.checked)} />
          <span>Skip visualizations (--no_visuals: no output page, so no Report tab)</span>
        </label>
        <label className={styles.checkboxField}>
          <input type="checkbox" checked={noServer} onChange={e => setNoServer(e.target.checked)} />
          <span>Don&apos;t start a local server (--no_server: the output page is still written)</span>
        </label>
      </div>
      <h4 className={styles.sectionTitle}>sbatch script</h4>
      <p className={styles.hint}>
        Regenerated live as fields above change. Editable - whatever&apos;s in this box when you click
        Run job is exactly what gets submitted and saved into the job&apos;s own folder.
      </p>
      {previewEdited && (
        <button
          type="button"
          className={styles.resetButton}
          onClick={() => { setPreviewEdited(false); refreshPreview(); }}
        >
          Reset to generated script
        </button>
      )}
      <textarea
        className={styles.scriptEditor}
        value={scriptPreview}
        onChange={e => {
          setPreviewEdited(true);
          setScriptPreview(e.target.value);
        }}
        spellCheck={false}
      />

      {error && <p className={styles.fieldError}>{error}</p>}

      <button type="submit" className={styles.submitButton} disabled={submitting || !workspaceActive}>
        {submitting ? 'Running...' : (editingJobId ? 'Resubmit' : 'Run job')}
      </button>
      <button
        type="button"
        className={styles.resetButton}
        onClick={downloadFiles}
        disabled={!scriptPreview || !inputJsonPreview}
      >
        Download files
      </button>
    </form>
  );
}

export default RunTab;

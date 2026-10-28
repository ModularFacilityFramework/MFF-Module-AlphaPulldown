// Setup tab - sbatch/cluster and ABCFold defaults, one row per user
// (GET/PUT /abcfold/settings). Only ever touches core through the coreApi
// prop - see docs/MFF-Core_module-core-api.md for the contract.
import React, { useEffect, useState } from 'react';
import styles from '../styles/SetupTab.module.css';

const FIELDS = [
  { key: 'env_name', label: 'Environment name', type: 'text' },
  { key: 'slurm_mail_type', label: 'Mail type (optional, e.g. END,FAIL)', type: 'text' },
  {
    key: 'default_database_dir',
    label: 'Local genetic database directory (for offline MSA generation, no internet needed)',
    type: 'text'
  }
];

// This module's own resource request - not looked up from anywhere, just
// what an ABCFold job actually needs to run (see backend/db/schema.sql's
// abcfold_settings table comment). Partition is handled separately, as a
// dropdown built from live cluster data when there is any (see the
// Partition field below) - these three are always used as typed.
const RESOURCE_FIELDS = [
  { key: 'default_cpus_per_task', label: 'CPUs per task', type: 'number' },
  { key: 'default_mem', label: 'Memory (e.g. 64G)', type: 'text' },
  { key: 'default_time', label: 'Wall time (e.g. 24:00:00)', type: 'text' }
];

const CHECKBOXES = [
  {
    key: 'default_mmseqs2',
    label: 'Use MMseqs2 (public ColabFold API - needs internet) instead of the local database above, by default'
  },
  { key: 'default_templates', label: 'Use templates by default' }
];

function SetupTab({ coreApi }) {
  const { api } = coreApi;
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Once the user directly edits the preview textarea, the live-refresh
  // effect below stops overwriting it - otherwise every keystroke in an
  // unrelated field 400ms later would silently clobber a manual edit.
  // "Reset to generated preview" is the explicit way back to live-synced.
  const [previewEdited, setPreviewEdited] = useState(false);

  useEffect(() => {
    api.get('/abcfold/settings')
      .then(res => {
        const data = res.data;
        // If the saved default_partition isn't one of the live cluster's
        // real partitions at all, default the dropdown to a GPU-capable
        // one instead of showing a stale/invalid selection - this only
        // changes what's shown, not what's saved, until Save is clicked.
        const partitions = data.partitions || [];
        const gpuPartitions = partitions.filter(p => p.gpusPerNode > 0);
        const isValid = partitions.some(p => p.name === data.default_partition);
        const resolvedDefaultPartition = (!isValid && gpuPartitions.length > 0) ? gpuPartitions[0].name : data.default_partition;
        setForm({ ...data, default_partition: resolvedDefaultPartition });
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  function refreshPreview() {
    return api.post('/abcfold/settings/preview', form)
      .then(res => setForm(f => (f ? { ...f, sbatchPreview: res.data.sbatchPreview } : f)))
      .catch(() => {});
  }

  // Live preview: regenerate the sbatch preview shortly after any editable
  // field changes, without waiting for Save - POST /settings/preview builds
  // the same response GET/PUT do, but never touches the database. Skipped
  // entirely once the user has directly edited the preview textarea
  // (previewEdited) - see its declaration above.
  useEffect(() => {
    if (!form || previewEdited) return undefined;
    const timer = setTimeout(refreshPreview, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api, previewEdited, form?.env_manager, form?.env_name, form?.slurm_mail_type,
    form?.default_partition, form?.default_cpus_per_task, form?.default_mem, form?.default_time,
    form?.default_mmseqs2, form?.default_database_dir, form?.default_templates
  ]);

  function updateField(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    api.put('/abcfold/settings', form)
      .then(res => {
        setForm(res.data);
        setSaved(true);
      })
      .catch(err => setError(err.response?.data?.message || err.message))
      .finally(() => setSaving(false));
  }

  if (loading) return <div className={styles.loading}>Loading...</div>;
  if (!form) return <div className={styles.errorBanner}>{error || 'Failed to load settings'}</div>;

  const workspace = form.workspace || { active: false, path: null, reason: null };
  // 'no_slurm_access': this specific user isn't registered as a Slurm user
  // at all (checked against sacctmgr on the Slurm module's side) - a
  // per-user permission fact, not the same thing as the module being down.
  // 'unreachable': anything else (not installed, network error, timeout).
  // Only affects the live partitions list below - it never blocks a job,
  // since default_partition always provides a real value to fall back on.
  const slurmMessage = form.slurmError === 'no_slurm_access'
    ? "You don't have Slurm access - ask an administrator to register your account with Slurm."
    : 'The Slurm module is not reachable right now.';
  const slurmDetail = (form.slurmErrorStatus || form.slurmErrorMessage)
    ? `status: ${form.slurmErrorStatus ?? 'none'}, error: ${form.slurmErrorMessage || 'none'}`
    : null;

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.submissionNote}>
        Partition/CPUs/memory/wall time below are this module&apos;s own resource request for an ABCFold
        job - real defaults, not something waiting on any external configuration. Partition is a dropdown
        of this cluster&apos;s actual GPU partitions when that data is available, defaulting to one that
        actually has GPUs; otherwise it&apos;s a plain field you can type into yourself. GRES scales with
        the GPU count you choose in the Run tab. Account, email, and each job&apos;s output directory are
        pulled automatically, from your core account and core-provisioned workspace.
      </p>

      {form.slurmError && (
        <p className={styles.errorBanner}>
          {slurmMessage}
          {slurmDetail && <><br /><code>{slurmDetail}</code></>}
        </p>
      )}

      {!workspace.active && (
        <p className={styles.errorBanner}>
          Your workspace storage isn&apos;t available ({workspace.reason || 'unknown reason'}) — you
          can&apos;t create or submit ABCFold jobs until this is resolved. Contact an administrator.
        </p>
      )}

      <h4 className={styles.sectionTitle}>Environment</h4>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Environment manager</span>
          <select value={form.env_manager} onChange={e => updateField('env_manager', e.target.value)}>
            <option value="micromamba">micromamba</option>
            <option value="conda">conda</option>
          </select>
        </label>
        {FIELDS.map(field => (
          <label key={field.key} className={styles.field}>
            <span>{field.label}</span>
            <input
              type={field.type}
              value={form[field.key] ?? ''}
              onChange={e => updateField(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
            />
          </label>
        ))}
      </div>

      <h4 className={styles.sectionTitle}>Resource request</h4>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Partition</span>
          {form.partitions && form.partitions.length > 0 ? (
            <select value={form.default_partition ?? ''} onChange={e => updateField('default_partition', e.target.value)}>
              {form.partitions.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name}{p.gpusPerNode > 0 ? ` (${p.gpusPerNode} GPUs/node)` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={form.default_partition ?? ''}
              onChange={e => updateField('default_partition', e.target.value)}
              placeholder={form.slurmError ? slurmMessage : ''}
            />
          )}
        </label>
        {RESOURCE_FIELDS.map(field => (
          <label key={field.key} className={styles.field}>
            <span>{field.label}</span>
            <input
              type={field.type}
              value={form[field.key] ?? ''}
              onChange={e => updateField(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
            />
          </label>
        ))}
      </div>

      <div className={styles.checkboxes}>
        {CHECKBOXES.map(cb => (
          <label key={cb.key} className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={!!form[cb.key]}
              onChange={e => updateField(cb.key, e.target.checked)}
            />
            <span>{cb.label}</span>
          </label>
        ))}
      </div>

      <h4 className={styles.sectionTitle}>From your core account</h4>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Account</span>
          <input type="text" value={form.account ?? ''} disabled />
        </label>
        <label className={styles.field}>
          <span>Email</span>
          <input type="text" value={form.email ?? ''} disabled placeholder="Not available yet" />
        </label>
        <label className={styles.field}>
          <span>Workspace directory</span>
          <input
            type="text"
            value={workspace.active ? workspace.path : ''}
            disabled
            placeholder={workspace.active ? '' : 'Not available'}
          />
        </label>
      </div>

      {error && <p className={styles.fieldError}>{error}</p>}
      {saved && <p className={styles.success}>Settings saved.</p>}

      <button type="submit" className={styles.saveButton} disabled={saving}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>

      <h4 className={styles.sectionTitle}>sbatch script preview</h4>
      <p className={styles.hint}>
        Generated from these settings using a placeholder job (single protein sequence, AlphaFold3) -
        actual jobs created in the Run tab will differ based on what you enter there. Editable - edit
        it directly to try out changes; use Reset to go back to what these settings actually generate.
      </p>
      {previewEdited && (
        <button
          type="button"
          className={styles.resetButton}
          onClick={() => { setPreviewEdited(false); refreshPreview(); }}
        >
          Reset to generated preview
        </button>
      )}
      <textarea
        className={styles.scriptEditor}
        value={form.sbatchPreview ?? ''}
        onChange={e => {
          setPreviewEdited(true);
          setForm(f => ({ ...f, sbatchPreview: e.target.value }));
        }}
        spellCheck={false}
      />
    </form>
  );
}

export default SetupTab;

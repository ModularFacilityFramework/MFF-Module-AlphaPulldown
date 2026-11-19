// Setup tab - the caller's own AlphaPulldown environment and resource
// settings, one row per user (GET/PUT /alphapulldown/settings). Only ever
// touches core through the coreApi prop - see docs/MFF-Core_module-core-api.md
// for the contract.
import React, { useEffect, useState } from 'react';
import styles from '../styles/SetupTab.module.css';

// type 'number' values are sent as numbers; the backend validates every
// field again (they end up inside generated sbatch scripts).
const ENVIRONMENT_FIELDS = [
  { key: 'env_name', label: 'Environment with AlphaPulldown and AlphaFold 3', type: 'text' },
  { key: 'slurm_mail_type', label: 'Mail type (optional, e.g. END,FAIL)', type: 'text' }
];

const PATH_FIELDS = [
  {
    key: 'data_dir',
    label: 'Genetic databases (--data_dir of the feature step) - required before a Features run',
    type: 'text',
    placeholder: '/absolute/path/to/genetic_db'
  },
  {
    key: 'pdb_seqres_path',
    label: 'PDB seqres file (optional; blank = pdb_seqres_2022_09_28.fasta inside the databases directory)',
    type: 'text',
    placeholder: '/absolute/path/to/pdb_seqres.txt'
  },
  {
    key: 'weights_dir',
    label: 'AlphaFold 3 model weights directory (--data_dir of the prediction step)',
    type: 'text',
    placeholder: '/absolute/path/to/alphafold3/models'
  },
  { key: 'max_template_date', label: 'Template cut-off date (YYYY-MM-DD)', type: 'text' }
];

const MSA_RESOURCE_FIELDS = [
  { key: 'msa_partition', label: 'Partition (blank = cluster default)', type: 'text' },
  { key: 'msa_cpus_per_task', label: 'CPUs per protein', type: 'number' },
  { key: 'msa_mem', label: 'Memory per protein (e.g. 64G)', type: 'text' },
  { key: 'msa_time', label: 'Wall time per protein (e.g. 10:00:00)', type: 'text' },
  { key: 'msa_array_throttle', label: 'Proteins searched at once (one Features job holds this many times the resources above)', type: 'number' }
];

const FOLD_RESOURCE_FIELDS = [
  { key: 'fold_partition', label: 'Partition (blank = cluster default)', type: 'text' },
  { key: 'fold_gres', label: 'GPUs per job (--gres, e.g. gpu:1 or gpu:rtx_a5000:1)', type: 'text' },
  { key: 'fold_cpus_per_task', label: 'CPUs per job', type: 'number' },
  { key: 'fold_mem', label: 'Memory per job (e.g. 64G)', type: 'text' },
  { key: 'fold_time', label: 'Wall time per job (e.g. 24:00:00)', type: 'text' }
];

const LIMIT_FIELDS = [
  { key: 'cofold_max_parallel', label: 'Prediction jobs in flight at once', type: 'number' },
  { key: 'warn_max_complex_aa', label: 'Warn when a complex is longer than (aa)', type: 'number' }
];

function renderField(field, form, updateField) {
  return (
    <label key={field.key} className={styles.field}>
      <span>{field.label}</span>
      <input
        type={field.type}
        value={form[field.key] ?? ''}
        placeholder={field.placeholder}
        onChange={e => updateField(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </label>
  );
}

function SetupTab({ coreApi }) {
  const { api } = coreApi;
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/alphapulldown/settings')
      .then(res => setForm(res.data))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [api]);

  function updateField(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    api.put('/alphapulldown/settings', form)
      .then(res => {
        setForm(res.data);
        setSaved(true);
      })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setSaving(false));
  }

  if (loading) return <div className={styles.loading}>Loading...</div>;
  if (!form) return <div className={styles.errorBanner}>{error || 'Failed to load settings'}</div>;

  const workspace = form.workspace || { active: false, path: null, reason: null };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.hint}>
        These are your own settings for AlphaPulldown&apos;s two steps: the Features (CPU) step runs
        create_individual_features.py, the Prediction (GPU) step runs run_multimer_jobs.py with the
        AlphaFold 3 backend, both as Slurm jobs in the environment named below. The defaults describe this
        cluster&apos;s installation (AlphaPulldown 2.9 with AlphaFold 3). Account, email and every project&apos;s
        files come from your core account and core-provisioned workspace.
      </p>

      {!workspace.active && (
        <p className={styles.errorBanner}>
          Your workspace storage isn&apos;t available ({workspace.reason || 'unknown reason'}) — you
          can&apos;t write project files or run jobs until this is resolved. Contact an administrator.
        </p>
      )}
      {!form.data_dir && (
        <p className={styles.submissionNote}>
          No genetic database directory is set yet. The Features step will not run until you set one below.
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
        {ENVIRONMENT_FIELDS.map(field => renderField(field, form, updateField))}
      </div>

      <h4 className={styles.sectionTitle}>Databases and model weights</h4>
      <div className={styles.grid}>
        {PATH_FIELDS.map(field => renderField(field, form, updateField))}
      </div>

      <h4 className={styles.sectionTitle}>Features (CPU) resources, per protein searched</h4>
      <div className={styles.grid}>
        {MSA_RESOURCE_FIELDS.map(field => renderField(field, form, updateField))}
      </div>

      <h4 className={styles.sectionTitle}>Prediction (GPU) resources, per complex</h4>
      <div className={styles.grid}>
        {FOLD_RESOURCE_FIELDS.map(field => renderField(field, form, updateField))}
      </div>
      <div className={styles.checkboxes}>
        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={!!form.fold_unified_memory}
            onChange={e => updateField('fold_unified_memory', e.target.checked ? 1 : 0)}
          />
          <span>Let AlphaFold 3 spill into host memory when the GPU&apos;s memory is full (unified memory: slower, but larger complexes finish)</span>
        </label>
      </div>

      <h4 className={styles.sectionTitle}>Limits</h4>
      <div className={styles.grid}>
        {LIMIT_FIELDS.map(field => renderField(field, form, updateField))}
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
    </form>
  );
}

export default SetupTab;

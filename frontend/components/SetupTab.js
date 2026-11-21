// Setup tab - the caller's own AlphaPulldown environment and resource
// settings, one row per user (GET/PUT /alphapulldown/settings). Only ever
// touches core through the coreApi prop - see docs/MFF-Core_module-core-api.md
// for the contract.
import React, { useCallback, useEffect, useState } from 'react';
import { rememberDraft, restoreDraft, usePageScope } from '../utils/pageState';
import styles from '../styles/SetupTab.module.css';

// type 'number' values are sent as numbers; the backend validates every
// field again (they end up inside generated sbatch scripts).
const ENVIRONMENT_FIELDS = [
  { key: 'env_name', label: 'Environment name', type: 'text' },
  {
    key: 'data_dir',
    label: 'Genetic database directory (--data_dir) - required before a features job can run',
    type: 'text',
    placeholder: '/absolute/path/to/databases'
  },
  {
    key: 'pdb_seqres_path',
    label: 'pdb_seqres file (blank = look for it in the database directory)',
    type: 'text',
    placeholder: '/absolute/path/to/pdb_seqres.txt'
  },
  { key: 'max_template_date', label: 'Template cut-off date (YYYY-MM-DD)', type: 'text' },
  { key: 'slurm_mail_type', label: 'Mail type (optional, e.g. END,FAIL)', type: 'text' }
];

const RESOURCE_FIELDS = [
  { key: 'msa_partition', label: 'Partition (blank = cluster default)', type: 'text' },
  { key: 'msa_cpus_per_task', label: 'CPUs per protein', type: 'number' },
  { key: 'msa_mem', label: 'Memory per protein (e.g. 64G)', type: 'text' },
  { key: 'msa_time', label: 'Wall time per protein (e.g. 10:00:00)', type: 'text' },
  { key: 'msa_array_throttle', label: 'Proteins searched at once (one MSA job holds this many times the resources above)', type: 'number' }
];

const LIMIT_FIELDS = [
  { key: 'cofold_max_parallel', label: 'Co-folding jobs in flight at once', type: 'number' },
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
  const { api, useAuth, useRoles } = coreApi;
  const { canManageUsers } = useRoles(useAuth().userData);
  const scope = usePageScope();
  const [form, setForm] = useState(null);
  const [serverForm, setServerForm] = useState(null); // what the server holds
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/alphapulldown/settings')
      .then(res => {
        setServerForm(res.data);
        // unsaved edits from before the user left come back
        setForm(restoreDraft(scope, 'setup:form', res.data) || res.data);
      })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [api, scope]);

  useEffect(() => {
    if (form && serverForm) rememberDraft(scope, 'setup:form', serverForm, form);
  }, [form, serverForm, scope]);

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
        setServerForm(res.data);
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
    <>
    {canManageUsers && <LibrarySettings api={api} />}
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.hint}>
        These are your own defaults for the Features (CPU) stage. Co-folding runs through the ABCFold module and
        uses that module&apos;s own settings. Account, email and every project&apos;s files come from your
        core account and core-provisioned workspace.
      </p>

      {!workspace.active && (
        <p className={styles.errorBanner}>
          Your workspace storage isn&apos;t available ({workspace.reason || 'unknown reason'}) — you
          can&apos;t write project files or run jobs until this is resolved. Contact an administrator.
        </p>
      )}
      {!form.data_dir && (
        <p className={styles.submissionNote}>
          No database directory is set yet. The Features stage will not run until you set one below.
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
      <p className={styles.hint}>
        Features are built with AlphaPulldown&apos;s AlphaFold 3 data pipeline, which searches these local databases
        (it has no MMseqs2 mode). Changing the template cut-off date or the database directory starts a separate
        feature set in the shared library; the old one is kept.
      </p>

      <h4 className={styles.sectionTitle}>Feature resources (per protein searched)</h4>
      <div className={styles.grid}>
        {RESOURCE_FIELDS.map(field => renderField(field, form, updateField))}
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
    </>
  );
}

// Staff only: where the one shared library lives and the feature set tag.
function LibrarySettings({ api }) {
  const scope = usePageScope();
  const [config, setConfig] = useState(null);
  const [libraryDir, setLibraryDir] = useState('');
  const [tag, setTag] = useState('v1');
  const [base, setBase] = useState(null); // what the server holds
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => api.get('/alphapulldown/library')
    .then(res => {
      const base = { libraryDir: res.data.libraryDir || '', tag: res.data.featureSetTag || 'v1' };
      const kept = restoreDraft(scope, 'setup:library', base) || base; // unsaved edits come back
      setConfig(res.data);
      setBase(base);
      setLibraryDir(kept.libraryDir);
      setTag(kept.tag);
    })
    .catch(err => setError(err.response?.data?.error || err.message)), [api, scope]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (base) rememberDraft(scope, 'setup:library', base, { libraryDir, tag });
  }, [base, libraryDir, tag, scope]);

  function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    api.put('/alphapulldown/library/config', { libraryDir, featureSetTag: tag })
      .then(() => { setSaved(true); return load(); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setSaving(false));
  }

  if (!config) return null;
  return (
    <form className={styles.form} onSubmit={save}>
      <h4 className={styles.sectionTitle}>Shared library (staff)</h4>
      <p className={styles.hint}>
        One folder holds every UniProt proteome and every feature set, one copy for all users. It must be
        writable by the account that runs mff-core and by the accounts that run users&apos; Slurm jobs
        (group-writable, ideally with the group bit inherited). The feature set tag is part of every
        feature set&apos;s name: change it whenever the genetic databases or the AlphaPulldown software are
        updated, so features built the old way and the new way never share a folder.
      </p>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Library folder</span>
          <input type="text" value={libraryDir} placeholder="/absolute/path/to/alphapulldown_library" onChange={e => { setLibraryDir(e.target.value); setSaved(false); }} />
        </label>
        <label className={styles.field}>
          <span>Feature set tag</span>
          <input type="text" value={tag} onChange={e => { setTag(e.target.value); setSaved(false); }} />
        </label>
      </div>
      {error && <p className={styles.fieldError}>{error}</p>}
      {saved && <p className={styles.success}>Library settings saved.</p>}
      <button type="submit" className={styles.saveButton} disabled={saving || !libraryDir.trim()}>
        {saving ? 'Saving...' : 'Save library settings'}
      </button>
    </form>
  );
}

export default SetupTab;

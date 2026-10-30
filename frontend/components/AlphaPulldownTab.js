// Top-level component registered via registerDashboardTab in ../index.js.
// coreApi renders whatever gets registered as `<entry.component />` with
// zero props and no routing - so tab switching below is plain React state,
// not real routes.
//
// No page-level heading here on purpose: this already renders as a
// labeled tab inside Dashboard's own tab bar (manifest.label, "AlphaPulldown"),
// plus a matching sidebar button (sidebarEntry: true) - core's module UI
// guide is explicit that a module shouldn't add a second title on top of
// either.
//
// A project (ProjectBar) owns one set of proteins and ties the three
// pipeline tabs together: Sequences -> MSA (CPU) -> Co-folding (GPU). The
// stats strip under the tab bar always describes the selected project.
//
// Tab visibility is gated by GET /alphapulldown/page-access (see
// backend/routes/pageAccessRoutes.js): staff (canManageUsers) always see
// every tab plus the staff-only Page Access tab itself; everyone else only
// sees tabs a role of theirs has been granted.
import React, { useCallback, useEffect, useState } from 'react';
import ProjectBar from './ProjectBar';
import StatsStrip from './StatsStrip';
import MsaTab from './MsaTab';
import CofoldTab from './CofoldTab';
import SequencesTab from './SequencesTab';
import SetupTab from './SetupTab';
import PageAccessTab from './PageAccessTab';
import styles from '../styles/AlphaPulldownTab.module.css';

// stage: a pipeline tab (needs a selected project, shows the stats strip).
const TABS = [
  { key: 'sequences', label: 'Sequences', stage: 'sequences', component: SequencesTab },
  { key: 'msa', label: 'MSA (CPU)', stage: 'msa', component: MsaTab },
  { key: 'cofold', label: 'Co-folding (GPU)', stage: 'cofold', component: CofoldTab },
  { key: 'setup', label: 'Setup', component: SetupTab }
];

function AlphaPulldownTab({ coreApi }) {
  const { api, useAuth, useRoles } = coreApi;
  const { userData } = useAuth();
  const { canManageUsers, roles: userRoles } = useRoles(userData);
  const [access, setAccess] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState(null);
  // Stats are kept with the project they belong to, so switching project
  // never shows the previous project's numbers while the new ones load -
  // but a refresh after an edit keeps the old numbers up instead of flashing.
  const [statsState, setStatsState] = useState({ projectId: null, data: null });
  const [statsVersion, setStatsVersion] = useState(0);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.get('/alphapulldown/page-access')
      .then(res => setAccess(res.data.access))
      .catch(() => setAccess({}));
  }, [api]);

  // Reloads the project list and keeps the current selection when it still
  // exists, otherwise selects `preferId` (a just-created project) or the
  // newest one.
  const loadProjects = useCallback((preferId) => api.get('/alphapulldown/projects')
    .then(res => {
      setProjects(res.data);
      setProjectId(prev => {
        if (preferId && res.data.some(p => p.id === preferId)) return preferId;
        if (prev && res.data.some(p => p.id === prev)) return prev;
        return res.data.length > 0 ? res.data[0].id : null;
      });
    })
    .catch(err => {
      setLoadError(err.response?.data?.error || err.message);
      setProjects([]);
    }), [api]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    if (!projectId) return;
    api.get(`/alphapulldown/projects/${projectId}/stats`)
      .then(res => setStatsState({ projectId, data: res.data }))
      .catch(() => setStatsState({ projectId, data: null }));
  }, [api, projectId, statsVersion]);

  // Something in the selected project changed (sequences added or removed):
  // recompute the stats strip and refresh the project list's counts.
  const handleChanged = useCallback(() => {
    setStatsVersion(v => v + 1);
    loadProjects();
  }, [loadProjects]);

  function handleCreate(name, mode) {
    return api.post('/alphapulldown/projects', { name, mode }).then(res => loadProjects(res.data.id));
  }

  function handleDelete(id) {
    return api.delete(`/alphapulldown/projects/${id}`).then(() => loadProjects());
  }

  if (access === null || projects === null) return <div className={styles.loading}>Loading...</div>;

  const visibleTabs = TABS.filter(
    tab => canManageUsers || (access[tab.key] || []).some(role => userRoles.includes(role))
  );
  if (canManageUsers) visibleTabs.push({ key: 'page-access', label: 'Page Access', component: PageAccessTab });

  const currentTab = visibleTabs.find(t => t.key === activeTab) || visibleTabs[0];
  if (!currentTab) return <div className={styles.loading}>You don&apos;t have access to any tab in this module.</div>;

  const ActiveComponent = currentTab.component;
  const currentProject = projects.find(p => p.id === projectId) || null;
  const needsProject = !!currentTab.stage;
  const stats = statsState.projectId === projectId ? statsState.data : null;

  return (
    <div>
      <ProjectBar
        projects={projects}
        currentId={projectId}
        onSelect={setProjectId}
        onCreate={handleCreate}
        onDelete={handleDelete}
      />
      {loadError && <p className={styles.error}>{loadError}</p>}

      <div className={styles.tabBar}>
        {visibleTabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            className={tab.key === currentTab.key ? `${styles.tabButton} ${styles.tabButtonActive}` : styles.tabButton}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {needsProject && currentProject && <StatsStrip stats={stats} stage={currentTab.stage} />}
        {needsProject && !currentProject ? (
          <div className={styles.empty}>Create a project above to begin.</div>
        ) : (
          <ActiveComponent coreApi={coreApi} stage={currentTab.stage} project={currentProject} onChanged={handleChanged} />
        )}
      </div>
    </div>
  );
}

export default AlphaPulldownTab;

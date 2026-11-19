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
// A project (ProjectBar) owns one target, one set of proteins and ties the
// pipeline tabs together: Target -> Baits -> (Sequences ->) Features (CPU) ->
// Co-folding (GPU). The Baits tab stays locked until the project's target is
// confirmed.
// The Library tab is not tied to a project: it is the proteomes and feature
// sets every user shares. The
// stats strip under the tab bar always describes the selected project.
//
// Tab visibility is gated by GET /alphapulldown/page-access (see
// backend/routes/pageAccessRoutes.js): staff (canManageUsers) always see
// every tab plus the staff-only Speed statistics and Page Access tabs; everyone else only
// sees tabs a role of theirs has been granted.
import React, { useCallback, useEffect, useState } from 'react';
import ProjectBar from './ProjectBar';
import StatsStrip from './StatsStrip';
import LibraryTab from './LibraryTab';
import TargetTab from './TargetTab';
import BaitsTab from './BaitsTab';
import MsaTab from './MsaTab';
import CofoldTab from './CofoldTab';
import SequencesTab from './SequencesTab';
import SetupTab from './SetupTab';
import SpeedTab from './SpeedTab';
import PageAccessTab from './PageAccessTab';
import styles from '../styles/AlphaPulldownTab.module.css';
import targetStyles from '../styles/TargetTab.module.css';

// stage: a pipeline tab (needs a selected project, shows the stats strip).
// needsProject: a tab that needs a selected project but shows no stats strip.
// lockedUntil: the tab is greyed out until this returns true for the project.
const TABS = [
  // Handles a missing project itself (staff still get the overview of every target).
  { key: 'target', label: 'Target', component: TargetTab },
  {
    key: 'baits',
    label: 'Baits',
    needsProject: true,
    component: BaitsTab,
    lockedMessage: 'Confirm the target first',
    isOpen: project => !!project && project.target_status === 'confirmed'
  },
  { key: 'sequences', label: 'Sequences', stage: 'sequences', component: SequencesTab },
  { key: 'library', label: 'Library', component: LibraryTab },
  { key: 'msa', label: 'Features (CPU)', stage: 'msa', component: MsaTab },
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
  if (canManageUsers) {
    visibleTabs.push({ key: 'speed', label: 'Speed statistics', component: SpeedTab });
    visibleTabs.push({ key: 'page-access', label: 'Page Access', component: PageAccessTab });
  }

  const currentProject = projects.find(p => p.id === projectId) || null;
  const isLocked = tab => !!tab.isOpen && !tab.isOpen(currentProject);
  // A locked tab cannot be the current one: fall back to the first open tab.
  const requested = visibleTabs.find(t => t.key === activeTab);
  const currentTab = (requested && !isLocked(requested) ? requested : visibleTabs.find(t => !isLocked(t))) || visibleTabs[0];
  if (!currentTab) return <div className={styles.loading}>You don&apos;t have access to any tab in this module.</div>;

  const ActiveComponent = currentTab.component;
  const needsProject = !!currentTab.stage || !!currentTab.needsProject;
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
        {visibleTabs.map(tab => {
          const locked = isLocked(tab);
          const classes = [styles.tabButton, tab.key === currentTab.key ? styles.tabButtonActive : '', locked ? targetStyles.tabLocked : ''];
          return (
            <button
              key={tab.key}
              type="button"
              className={classes.filter(Boolean).join(' ')}
              onClick={() => { if (!locked) setActiveTab(tab.key); }}
              aria-disabled={locked}
              title={locked ? tab.lockedMessage : undefined}
            >
              {locked ? `${tab.label} (locked)` : tab.label}
            </button>
          );
        })}
      </div>

      <div className={styles.content}>
        {!!currentTab.stage && currentProject && <StatsStrip stats={stats} stage={currentTab.stage} />}
        {needsProject && !currentProject ? (
          <div className={styles.empty}>Create a project above to begin.</div>
        ) : (
          <ActiveComponent
            coreApi={coreApi}
            stage={currentTab.stage}
            project={currentProject}
            onChanged={handleChanged}
            isStaff={canManageUsers}
            onNavigate={setActiveTab}
          />
        )}
      </div>
    </div>
  );
}

export default AlphaPulldownTab;

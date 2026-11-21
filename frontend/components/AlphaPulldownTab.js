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
// A project (ProjectBar) holds one or many targets (TargetBar). The tabs
// follow the workflow: Target -> Baits -> AlphaPulldown -> Modelling (ABCFold)
// -> Summary. Only Target works so far; each later tab is visible but locked
// until the step before it is confirmed (and until it is built). The Library
// tab is not tied to a project: it is the proteomes and feature sets every
// user shares.
//
// Tab visibility is gated by GET /alphapulldown/page-access (see
// backend/routes/pageAccessRoutes.js): staff (canManageUsers) always see
// every tab plus the staff-only Speed statistics and Page Access tabs; everyone else only
// sees tabs a role of theirs has been granted.
import React, { useCallback, useEffect, useState } from 'react';
import ProjectBar from './ProjectBar';
import TargetBar, { NEW_TARGET } from './TargetBar';
import TargetTab from './TargetTab';
import BaitsTab from './BaitsTab';
import LockedStep from './LockedStep';
import LibraryTab from './LibraryTab';
import SetupTab from './SetupTab';
import SpeedTab from './SpeedTab';
import PageAccessTab from './PageAccessTab';
import { PageStateProvider, readPageState, usePageScope, usePageState } from '../utils/pageState';
import styles from '../styles/AlphaPulldownTab.module.css';
import targetStyles from '../styles/TargetTab.module.css';

const never = () => false;

// usesTarget: shows the target selector. isOpen({ project, target }): the tab
// is greyed out (locked) until it returns true.
const TABS = [
  { key: 'target', label: 'Target', usesTarget: true, component: TargetTab },
  {
    key: 'baits',
    label: 'Baits',
    usesTarget: true,
    needsProject: true,
    component: BaitsTab,
    lockedMessage: 'Confirm the target first',
    isOpen: ({ target }) => !!target && target.status === 'confirmed'
  },
  { key: 'alphapulldown', label: 'AlphaPulldown', component: LockedStep, lockedMessage: 'Needs the confirmed baits (not built yet)', isOpen: never },
  { key: 'modelling', label: 'Modelling (ABCFold)', component: LockedStep, lockedMessage: 'Needs the AlphaPulldown step (not built yet)', isOpen: never },
  { key: 'summary', label: 'Summary', component: LockedStep, lockedMessage: 'Needs the modelling step (not built yet)', isOpen: never },
  { key: 'library', label: 'Library', component: LibraryTab },
  { key: 'setup', label: 'Setup', component: SetupTab }
];

function AlphaPulldownPages({ coreApi, userData }) {
  const { api, useRoles } = coreApi;
  const scope = usePageScope();
  const { canManageUsers, roles: userRoles } = useRoles(userData);
  const [access, setAccess] = useState(null);
  // What the user last had open is remembered per user (see utils/pageState):
  // the tab, the project and, per project, the target. A remembered item that
  // no longer exists falls back to the first one below, without an error.
  const [activeTab, setActiveTab] = usePageState('tab', null);
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = usePageState('project', null);
  const [, setChosenTargets] = usePageState('targets', {});
  // The selected project's targets, kept with the project they belong to so
  // switching project never shows the previous project's targets.
  const [targetState, setTargetState] = useState({ projectId: null, list: [], readOnly: false });
  const [targetId, setTargetId] = useState(NEW_TARGET);
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
    }), [api, setProjectId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Reloads the selected project's targets and keeps the selection when it
  // still exists, otherwise selects `preferId` (a just-saved target), the
  // first target, or a new one.
  const loadTargets = useCallback((preferId) => {
    if (!projectId) return Promise.resolve();
    return api.get(`/alphapulldown/projects/${projectId}/targets`)
      .then(res => {
        const list = res.data.targets;
        setTargetState({ projectId, list, readOnly: res.data.readOnly });
        setTargetId(prev => {
          if (preferId && list.some(t => t.id === preferId)) return preferId;
          if (prev === NEW_TARGET) return NEW_TARGET; // the user's own choice, or no target yet
          if (typeof prev === 'number' && list.some(t => t.id === prev)) return prev;
          return list.length > 0 ? list[0].id : NEW_TARGET;
        });
      })
      .catch(() => setTargetState({ projectId, list: [], readOnly: false }));
  }, [api, projectId]);

  useEffect(() => {
    // The target remembered for this project, if any; otherwise not chosen
    // yet: loadTargets picks the first target, or a new one.
    const remembered = readPageState(scope, 'targets', {})[projectId];
    setTargetId(remembered === NEW_TARGET || typeof remembered === 'number' ? remembered : null);
    setTargetState({ projectId: null, list: [], readOnly: false });
    loadTargets();
  }, [loadTargets, projectId, scope]);

  // Remember the chosen target (or "new target") for this project.
  useEffect(() => {
    if (projectId && targetId !== null && targetState.projectId === projectId) {
      setChosenTargets(prev => (prev[projectId] === targetId ? prev : { ...prev, [projectId]: targetId }));
    }
  }, [projectId, targetId, targetState.projectId, setChosenTargets]);

  // Something in the selected project changed (a target was saved or
  // confirmed): refresh the target list and the project list's counts.
  const handleChanged = useCallback(() => {
    loadTargets();
    loadProjects();
  }, [loadTargets, loadProjects]);

  const handleTargetSaved = useCallback(id => {
    loadTargets(id);
    loadProjects();
  }, [loadTargets, loadProjects]);

  function handleDeleteTarget(id) {
    return api.delete(`/alphapulldown/targets/${id}`).then(() => {
      setTargetId(null); // loadTargets then picks the first remaining target, or a new one
      return Promise.all([loadTargets(), loadProjects()]);
    });
  }

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
  const targets = targetState.projectId === projectId ? targetState.list : [];
  const currentTarget = typeof targetId === 'number' ? targets.find(t => t.id === targetId) || null : null;
  const isLocked = tab => !!tab.isOpen && !tab.isOpen({ project: currentProject, target: currentTarget });
  // A locked tab cannot be the current one: fall back to the first open tab.
  const requested = visibleTabs.find(t => t.key === activeTab);
  const currentTab = (requested && !isLocked(requested) ? requested : visibleTabs.find(t => !isLocked(t))) || visibleTabs[0];
  if (!currentTab) return <div className={styles.loading}>You don&apos;t have access to any tab in this module.</div>;

  const ActiveComponent = currentTab.component;
  const needsProject = !!currentTab.needsProject;

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
        {currentTab.usesTarget && currentProject && targetState.projectId === projectId && (
          <TargetBar
            targets={targets}
            targetId={targetId}
            readOnly={targetState.readOnly}
            onSelect={setTargetId}
            onDelete={handleDeleteTarget}
          />
        )}
        {needsProject && !currentProject ? (
          <div className={styles.empty}>Create a project above to begin.</div>
        ) : currentTab.usesTarget && currentProject && targetState.projectId !== projectId ? (
          <div className={styles.loading}>Loading...</div>
        ) : (
          <ActiveComponent
            coreApi={coreApi}
            label={currentTab.label}
            project={currentProject}
            target={currentTarget}
            targetId={targetId}
            onChanged={handleChanged}
            onSaved={handleTargetSaved}
            isStaff={canManageUsers}
            onNavigate={setActiveTab}
          />
        )}
      </div>
    </div>
  );
}

function AlphaPulldownTab({ coreApi }) {
  const { userData } = coreApi.useAuth();
  const userId = userData && userData.user ? userData.user.id : null;
  return (
    <PageStateProvider userId={userId}>
      <AlphaPulldownPages coreApi={coreApi} userData={userData} />
    </PageStateProvider>
  );
}

export default AlphaPulldownTab;

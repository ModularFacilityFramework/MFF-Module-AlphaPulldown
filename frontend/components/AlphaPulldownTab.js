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
// Projects belong to the Science module. Core's project tabs sit at the top
// of the page (one tab per project the user can see, the Project template
// first, + New project), and everything below shows the open project's items:
// its targets (one or many, chosen in TargetBar) and its runs. The Project
// template holds older work only. The tabs below follow the workflow: Target
// -> Baits -> AlphaPulldown -> Modelling (ABCFold) -> Summary. Only Target
// works so far; each later tab is visible but locked until the step before it
// is confirmed (and until it is built). The Library tab is not tied to a
// project: it is the proteomes and feature sets every user shares.
//
// Tab visibility is gated by GET /alphapulldown/page-access (see
// backend/routes/pageAccessRoutes.js): staff (canManageUsers) always see
// every tab plus the staff-only Speed statistics and Page Access tabs; everyone else only
// sees tabs a role of theirs has been granted.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import TargetBar, { NEW_TARGET } from './TargetBar';
import TargetTab from './TargetTab';
import BaitsTab from './BaitsTab';
import LockedStep from './LockedStep';
import LibraryTab from './LibraryTab';
import SetupTab from './SetupTab';
import SpeedTab from './SpeedTab';
import PageAccessTab from './PageAccessTab';
import { PageStateProvider, usePageState } from '../utils/pageState';
import styles from '../styles/AlphaPulldownTab.module.css';
import targetStyles from '../styles/TargetTab.module.css';

const never = () => false;
const NO_TARGETS = { projectId: null, project: null, list: [], readOnly: false, readOnlyReason: '', error: '' };

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

// Everything under the project tabs. `selection` is core's account of the open
// project tab.
function ProjectPage({ coreApi, selection, access, canManageUsers, userRoles }) {
  const { api } = coreApi;
  // The open project. While core reloads its list (ready false) the last one
  // stays, so nothing the user is doing is thrown away.
  const lastProject = useRef(null);
  if (selection.ready) lastProject.current = selection.projectId ? Number(selection.projectId) : null;
  const projectId = lastProject.current;

  // What the user last had open is remembered per user (see utils/pageState):
  // the tab and, per project, the target (core's ProjectTabs remembers the
  // project). A remembered item that no longer exists falls back without an
  // error.
  const [activeTab, setActiveTab] = usePageState('tab', null);
  const [chosenTargets, setChosenTargets] = usePageState('science-targets', {});
  const chosenRef = useRef(chosenTargets);
  chosenRef.current = chosenTargets;
  // The selected project's targets, kept with the project they belong to so
  // switching project never shows the previous project's targets.
  const [targetState, setTargetState] = useState(NO_TARGETS);
  const [targetId, setTargetId] = useState(NEW_TARGET);
  const [notice, setNotice] = useState('');

  // Reloads the selected project's targets and keeps the selection when it
  // still exists, otherwise selects `preferId` (a just-saved target), the
  // first target, or a new one.
  const loadTargets = useCallback((preferId) => {
    if (!projectId) return Promise.resolve();
    return api.get(`/alphapulldown/projects/${projectId}/targets`)
      .then(res => {
        const list = res.data.targets;
        setTargetState({ projectId, project: res.data.project, list, readOnly: res.data.readOnly, readOnlyReason: res.data.readOnlyReason || '', error: '' });
        setTargetId(prev => {
          if (preferId && list.some(t => t.id === preferId)) return preferId;
          // the user's own choice, or no target yet; not where nothing can be created
          if (prev === NEW_TARGET && !(res.data.readOnly && list.length > 0)) return NEW_TARGET;
          if (typeof prev === 'number' && list.some(t => t.id === prev)) return prev;
          return list.length > 0 ? list[0].id : NEW_TARGET;
        });
      })
      .catch(err => setTargetState({ ...NO_TARGETS, projectId, error: err.response?.data?.error || err.message }));
  }, [api, projectId]);

  useEffect(() => {
    // The target remembered for this project, if any; otherwise not chosen
    // yet: loadTargets picks the first target, or a new one.
    const remembered = chosenRef.current[projectId];
    setTargetId(remembered === NEW_TARGET || typeof remembered === 'number' ? remembered : null);
    setTargetState(NO_TARGETS);
    setNotice('');
    loadTargets();
  }, [loadTargets, projectId]);

  // Remember the chosen target (or "new target") for this project.
  useEffect(() => {
    if (projectId && targetId !== null && targetState.projectId === projectId) {
      setChosenTargets(prev => (prev[projectId] === targetId ? prev : { ...prev, [projectId]: targetId }));
    }
  }, [projectId, targetId, targetState.projectId, setChosenTargets]);

  // Something in the selected project changed (a target was saved or
  // confirmed): refresh the target list.
  const handleChanged = useCallback(() => { loadTargets(); }, [loadTargets]);

  // A new or deleted target also changes the count on the project's tab.
  const refreshTabs = selection.refresh;
  const handleTargetSaved = useCallback(id => {
    loadTargets(id);
    if (refreshTabs) refreshTabs();
  }, [loadTargets, refreshTabs]);

  function handleDeleteTarget(id) {
    return api.delete(`/alphapulldown/targets/${id}`).then(res => {
      setNotice(res.data?.itemWarning || '');
      setTargetId(null); // loadTargets then picks the first remaining target, or a new one
      if (refreshTabs) refreshTabs();
      return loadTargets();
    });
  }

  const visibleTabs = TABS.filter(
    tab => canManageUsers || (access[tab.key] || []).some(role => userRoles.includes(role))
  );
  if (canManageUsers) {
    visibleTabs.push({ key: 'speed', label: 'Speed statistics', component: SpeedTab });
    visibleTabs.push({ key: 'page-access', label: 'Page Access', component: PageAccessTab });
  }

  // The picked project, as the server described it for the caller (null until
  // that has arrived, and when it could not be read).
  const loaded = !!projectId && targetState.projectId === projectId;
  const currentProject = loaded ? targetState.project : null;
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
      {loaded && targetState.error && <p className={styles.error}>{targetState.error}</p>}
      {loaded && targetState.readOnlyReason && !(currentProject && currentProject.isTemplate) && <p className={styles.error}>{targetState.readOnlyReason}</p>}
      {notice && <p className={styles.error}>{notice}</p>}

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
        {currentTab.usesTarget && currentProject && (targets.length > 0 || !targetState.readOnly) && (
          <TargetBar
            targets={targets}
            targetId={targetId}
            readOnly={targetState.readOnly}
            canCreate={!!selection.canCreate}
            onSelect={setTargetId}
            onDelete={handleDeleteTarget}
          />
        )}
        {(needsProject || currentTab.usesTarget) && !selection.ready && !projectId ? null : needsProject && !projectId ? (
          <div className={styles.empty}>Open a project tab above to begin.</div>
        ) : currentTab.usesTarget && projectId && !loaded ? (
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
            selection={selection}
            isStaff={canManageUsers}
            onNavigate={setActiveTab}
          />
        )}
      </div>
    </div>
  );
}

function AlphaPulldownPages({ coreApi, userData }) {
  const { api, useRoles } = coreApi;
  const ProjectTabs = coreApi.ui && coreApi.ui.ProjectTabs;
  const { canManageUsers, roles: userRoles } = useRoles(userData);
  const [access, setAccess] = useState(null);

  useEffect(() => {
    api.get('/alphapulldown/page-access')
      .then(res => setAccess(res.data.access))
      .catch(() => setAccess({}));
  }, [api]);

  if (!ProjectTabs) return <p className={styles.error}>This MFF-core is too old for AlphaPulldown: project tabs need core 0.1.227 or later.</p>;
  if (access === null) return <div className={styles.loading}>Loading...</div>;
  return (
    <ProjectTabs rememberAs="alphapulldown.projects" moduleId="alphapulldown">
      {selection => <ProjectPage coreApi={coreApi} selection={selection} access={access} canManageUsers={canManageUsers} userRoles={userRoles} />}
    </ProjectTabs>
  );
}

function AlphaPulldownTab({ coreApi }) {
  const { userData } = coreApi.useAuth();
  const userId = userData && userData.user ? userData.user.id : null;
  return (
    <PageStateProvider coreApi={coreApi} userId={userId}>
      <AlphaPulldownPages coreApi={coreApi} userData={userData} />
    </PageStateProvider>
  );
}

export default AlphaPulldownTab;

// Top-level component registered via registerDashboardTab in ../index.js.
// coreApi renders whatever gets registered as `<entry.component />` with
// zero props and no routing - so Setup/Run/Results switching below is
// plain React state, not real routes.
//
// No page-level heading here on purpose: this already renders as a
// labeled tab inside Dashboard's own tab bar (manifest.label, "ABCFold"),
// plus a matching sidebar button (sidebarEntry: true) - core's module UI
// guide is explicit that a module shouldn't add a second title on top of
// either.
//
// Tab visibility is gated by GET /abcfold/page-access (see
// backend/routes/pageAccessRoutes.js): staff (canManageUsers) always see
// every tab plus the staff-only Page Access tab itself; everyone else only
// sees tabs a role of theirs has been granted.
import React, { useEffect, useState } from 'react';
import SetupTab from './SetupTab';
import RunTab from './RunTab';
import ResultsTab from './ResultsTab';
import PageAccessTab from './PageAccessTab';
import styles from '../styles/ABCFoldTab.module.css';

const TABS = [
  { key: 'setup', label: 'Setup', component: SetupTab },
  { key: 'run', label: 'Run', component: RunTab },
  { key: 'results', label: 'Results', component: ResultsTab }
];

function ABCFoldTab({ coreApi }) {
  const { api, useAuth, useRoles } = coreApi;
  const { userData } = useAuth();
  const { canManageUsers, roles: userRoles } = useRoles(userData);
  const [access, setAccess] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  // Run tab prefill, and which job (if any) it's editing in place - see
  // ResultsTab.js's Resubmit/Clone actions and RunTab.js's own prefill/
  // editingJobId props. null editingJobId with a non-null prefill is
  // Clone (pre-filled, but still creates a brand new job on submit).
  // runPrefillStatus distinguishes a real restore ('found') from "asked to
  // restore, but this job predates saved parameters" ('not_found') from
  // "no restore was attempted at all, ordinary fresh Run tab" (null) - the
  // three need different (or no) banners in RunTab.js, not the silence a
  // bare nullable prefill value used to produce either way.
  const [runPrefill, setRunPrefill] = useState(null);
  const [runPrefillStatus, setRunPrefillStatus] = useState(null);
  const [editingJobId, setEditingJobId] = useState(null);

  useEffect(() => {
    api.get('/abcfold/page-access')
      .then(res => setAccess(res.data.access))
      .catch(() => setAccess({}));
  }, [api]);

  if (access === null) return <div className={styles.loading}>Loading...</div>;

  const visibleTabs = TABS.filter(
    tab => canManageUsers || (access[tab.key] || []).some(role => userRoles.includes(role))
  );
  if (canManageUsers) visibleTabs.push({ key: 'page-access', label: 'Page Access', component: PageAccessTab });

  const currentTab = visibleTabs.find(t => t.key === activeTab) || visibleTabs[0];
  if (!currentTab) return <div className={styles.loading}>You don&apos;t have access to any tab in this module.</div>;

  const ActiveComponent = currentTab.component;
  // RunTab and ResultsTab are the two tabs that need extra props, all for
  // the same reason: jumping to another tab is plain React state here, not
  // routing. RunTab needs to land on Results after creating/resubmitting a
  // job, plus whatever prefill/editingJobId Results handed it (if any).
  // ResultsTab needs a way back to Setup (e.g. to adjust resource/
  // environment settings), and a way to push a job's own parameters into
  // Run tab state before switching there (Resubmit edits that same job in
  // place, Clone always starts a new one - see RunTab.js's own handling of
  // editingJobId).
  let extraProps = {};
  if (currentTab.key === 'run') {
    extraProps = {
      prefill: runPrefill,
      prefillStatus: runPrefillStatus,
      editingJobId,
      onJobCreated: () => {
        setRunPrefill(null);
        setRunPrefillStatus(null);
        setEditingJobId(null);
        setActiveTab('results');
      }
    };
  }
  if (currentTab.key === 'results') {
    extraProps = {
      onGoToSetup: () => setActiveTab('setup'),
      // result is loadJobParams()'s own { status, params? } shape (see
      // ResultsTab.js) - passed straight through rather than unwrapped
      // here, so RunTab.js can tell "found" and "not_found" apart itself.
      onEditJob: (result, jobId) => {
        setRunPrefill(result.status === 'found' ? result.params : null);
        setRunPrefillStatus(result.status);
        setEditingJobId(jobId);
        setActiveTab('run');
      },
      onCloneJob: result => {
        setRunPrefill(result.status === 'found' ? result.params : null);
        setRunPrefillStatus(result.status);
        setEditingJobId(null);
        setActiveTab('run');
      }
    };
  }

  return (
    <div>
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
        <ActiveComponent coreApi={coreApi} {...extraProps} />
      </div>
    </div>
  );
}

export default ABCFoldTab;

// Target tab: the target of the selected project, plus - for developers and
// administrators - every user's targets to open read-only.
import React, { useEffect, useRef, useState } from 'react';
import TargetEditor from './TargetEditor';
import { usePageState } from '../utils/pageState';
import { SortHeader, useSortedRows } from '../utils/sortableTable';
import shared from '../styles/SequencesTab.module.css';

function when(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '';
}

// "P-0001 Title"; a project that could not be read has no number.
const projectLabel = t => [t.projectNumber, t.projectName].filter(Boolean).join(' ');

function StaffOverview({ api, onOpen }) {
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/alphapulldown/targets')
      .then(res => setTargets(res.data.targets))
      .catch(err => setError(err.response?.data?.error || err.message));
  }, [api]);

  const table = useSortedRows(targets || [], {
    owner: t => t.ownerName || t.ownerId,
    project: projectLabel,
    name: t => t.name,
    status: t => t.status,
    genome: t => t.genome,
    chains: { value: t => t.chains, type: 'number' },
    unconfirmed: { value: t => t.unconfirmedChains, type: 'number' },
    updated: { value: t => t.updatedAt, type: 'date' }
  }, { rememberAs: 'alphapulldown.target.all-users' });

  if (error) return <p className={shared.errorText}>{error}</p>;
  if (!targets) return null;
  return (
    <div className={shared.panel}>
      <h3 className={shared.panelTitle}>{`All users' targets (${targets.length})`}</h3>
      {targets.length === 0 ? <p className={shared.empty}>No target has been saved yet.</p> : (
        <div className={shared.tableWrapper}>
          <table className={shared.table}>
            <thead><tr><th /><SortHeader table={table} column="owner">Owner</SortHeader><SortHeader table={table} column="project">Project</SortHeader><SortHeader table={table} column="name">Target</SortHeader><SortHeader table={table} column="status">Status</SortHeader><SortHeader table={table} column="genome">Genome</SortHeader><SortHeader table={table} column="chains" className={shared.numeric}>Chains</SortHeader><SortHeader table={table} column="unconfirmed" className={shared.numeric}>Not confirmed</SortHeader><SortHeader table={table} column="updated">Updated</SortHeader></tr></thead>
            <tbody>
              {table.rows.map(t => (
                <tr key={t.targetId}>
                  <td><button type="button" className={shared.btnBlue} onClick={() => onOpen(t)}>View</button></td>
                  <td>{t.ownerName || t.ownerId}</td>
                  <td>{projectLabel(t)}</td>
                  <td>{t.name}</td>
                  <td>{t.status}</td>
                  <td>{t.genome}</td>
                  <td className={shared.numeric}>{t.chains}</td>
                  <td className={shared.numeric}>{t.unconfirmedChains}</td>
                  <td>{when(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// targetId: the selected target of the project (a number), or 'new' for a
// target that has not been saved yet. onSaved(id) is called when a new target
// has just been saved; onChanged() after any other change.
function TargetTab({ coreApi, project, targetId, onChanged, onSaved, isStaff }) {
  // A staff member who opened somebody else's target from the overview;
  // null = the selected project's own target.
  // Remembered across leaving and reloading (a target that is gone shows its
  // error with a Back button).
  const [viewing, setViewing] = usePageState('target-viewing', null);
  const projectId = project ? project.id : null;

  // Switching project goes back to that project's own target (not on first show).
  const shownProject = useRef(projectId);
  useEffect(() => {
    if (shownProject.current !== projectId) { shownProject.current = projectId; setViewing(null); }
  }, [projectId, setViewing]);

  if (viewing) {
    return (
      <TargetEditor
        key={`view-${viewing.targetId}`}
        coreApi={coreApi}
        projectId={viewing.projectId}
        targetId={viewing.targetId}
        onBack={() => setViewing(null)}
      />
    );
  }
  return (
    <div>
      {project
        ? (
          <TargetEditor
            key={`${project.id}-${targetId}`}
            coreApi={coreApi}
            projectId={project.id}
            targetId={typeof targetId === 'number' ? targetId : null}
            onChanged={onChanged}
            onSaved={onSaved}
          />
        )
        : <div className={shared.empty}>Pick a project above to define its targets. Projects are created and shared in Science; picking one needs write access to it.</div>}
      {isStaff && <StaffOverview api={coreApi.api} onOpen={setViewing} />}
    </div>
  );
}

export default TargetTab;

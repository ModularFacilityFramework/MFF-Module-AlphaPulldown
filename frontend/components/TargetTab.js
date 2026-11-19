// Target tab: the target of the selected project, plus - for developers and
// administrators - every user's targets to open read-only.
import React, { useEffect, useState } from 'react';
import TargetEditor from './TargetEditor';
import shared from '../styles/SequencesTab.module.css';

function when(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '';
}

function StaffOverview({ api, onOpen }) {
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/alphapulldown/targets')
      .then(res => setTargets(res.data.targets))
      .catch(err => setError(err.response?.data?.error || err.message));
  }, [api]);

  if (error) return <p className={shared.errorText}>{error}</p>;
  if (!targets) return null;
  return (
    <div className={shared.panel}>
      <h3 className={shared.panelTitle}>{`All users' targets (${targets.length})`}</h3>
      {targets.length === 0 ? <p className={shared.empty}>No target has been saved yet.</p> : (
        <div className={shared.tableWrapper}>
          <table className={shared.table}>
            <thead><tr><th /><th>Owner</th><th>Project</th><th>Target</th><th>Status</th><th>Genome</th><th className={shared.numeric}>Chains</th><th className={shared.numeric}>Not confirmed</th><th>Updated</th></tr></thead>
            <tbody>
              {targets.map(t => (
                <tr key={t.projectId}>
                  <td><button type="button" className={shared.btnBlue} onClick={() => onOpen(t.projectId)}>View</button></td>
                  <td>{t.ownerName || t.ownerId}</td>
                  <td>{`P${t.projectNumber} - ${t.projectName}`}</td>
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

function TargetTab({ coreApi, project, onChanged, isStaff }) {
  // A staff member who opened somebody else's target (project id) from the
  // overview; null = the selected project's own target.
  const [viewing, setViewing] = useState(null);
  const projectId = project ? project.id : null;

  useEffect(() => { setViewing(null); }, [projectId]);

  if (viewing) {
    return <TargetEditor key={`view-${viewing}`} coreApi={coreApi} projectId={viewing} onBack={() => setViewing(null)} />;
  }
  return (
    <div>
      {project
        ? <TargetEditor key={project.id} coreApi={coreApi} projectId={project.id} onChanged={onChanged} />
        : <div className={shared.empty}>Create a project above to define its target.</div>}
      {isStaff && <StaffOverview api={coreApi.api} onOpen={setViewing} />}
    </div>
  );
}

export default TargetTab;

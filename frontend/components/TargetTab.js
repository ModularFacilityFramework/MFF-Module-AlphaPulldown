// Target tab: the selected target of the selected project (or a new one), and
// the project's runs. Everything shown belongs to the project tab that is
// open; the Project template holds older work only.
import React from 'react';
import TargetEditor from './TargetEditor';
import ProjectRuns from './ProjectRuns';
import shared from '../styles/SequencesTab.module.css';

// project: the open project tab's project as the server described it (null =
// none to show). targetId: the selected target of the project (a number), or
// 'new' for a target that has not been saved yet. selection: what core's
// ProjectTabs says about the open tab. onSaved(id) is called when a new
// target has just been saved; onChanged() after any other change.
function TargetTab({ coreApi, project, targetId, selection, onChanged, onSaved }) {
  if (!project) return <div className={shared.empty}>Open a project tab above to see its targets and runs.</div>;

  const isNew = typeof targetId !== 'number';
  const ProjectTask = coreApi.ui && coreApi.ui.ProjectTask;
  const editor = (
    <TargetEditor
      key={`${project.id}-${targetId}`}
      coreApi={coreApi}
      projectId={project.id}
      targetId={isNew ? null : targetId}
      onChanged={onChanged}
      onSaved={onSaved}
    />
  );

  let body = editor;
  if (isNew && project.isTemplate) {
    body = <div className={shared.empty}>No older target here. The Project template only holds older work: choose another project tab to define a target.</div>;
  } else if (isNew && ProjectTask) {
    // Core greys the new-target form, with the reason, when nothing may be
    // created in this project.
    body = <ProjectTask selection={selection} need="selected">{editor}</ProjectTask>;
  }

  return (
    <div>
      {project.isTemplate && <p className={shared.hint}>Older AlphaPulldown work that is not in a project: your own (administrators and developers see everyone&apos;s). It can be read, not changed.</p>}
      {body}
      <ProjectRuns api={coreApi.api} projectId={project.id} />
    </div>
  );
}

export default TargetTab;

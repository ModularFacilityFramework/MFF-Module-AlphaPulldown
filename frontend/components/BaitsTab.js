// Baits tab. A shell for now: the tab exists but opens only once the project's
// target is confirmed (AlphaPulldownTab keeps it locked until then). Picking
// baits from the target's genome is the next step.
import React from 'react';
import styles from '../styles/TargetTab.module.css';
import shared from '../styles/SequencesTab.module.css';

function BaitsTab({ project, onNavigate }) {
  if (!project || project.target_status !== 'confirmed') {
    return (
      <div className={styles.locked}>
        <p>Confirm the target first. The baits are picked from the target&apos;s genome, so this tab opens once the target is confirmed.</p>
        {onNavigate && <button type="button" className={shared.btnBlue} onClick={() => onNavigate('target')}>Go to the Target tab</button>}
      </div>
    );
  }
  return (
    <div className={shared.panel}>
      <h3 className={shared.panelTitle}>Baits</h3>
      <p className={shared.hint}>The target is confirmed. Picking baits from its genome comes next.</p>
    </div>
  );
}

export default BaitsTab;

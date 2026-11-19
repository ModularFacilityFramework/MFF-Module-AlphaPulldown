// A workflow step that is visible but not available yet. AlphaPulldownTab keeps
// its tab locked, so this is only what a locked step says if it is ever shown.
import React from 'react';
import styles from '../styles/TargetTab.module.css';

function LockedStep({ label }) {
  return <div className={styles.locked}>{`${label || 'This step'} is not available yet.`}</div>;
}

export default LockedStep;

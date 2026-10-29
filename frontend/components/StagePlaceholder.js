// Stand-in for the pipeline tabs not built yet: says what the
// tab will do instead of rendering an empty page. Replaced one tab at a time.
import React from 'react';
import styles from '../styles/AlphaPulldownTab.module.css';

const DESCRIPTIONS = {
  cofold: 'Runs ABCFold for every bait-candidate pair through the ABCFold module, with a cap on how many jobs are in flight, and tracks them to completion.'
};

function StagePlaceholder({ stage }) {
  return (
    <div className={styles.empty}>
      <strong>Not built yet.</strong> {DESCRIPTIONS[stage]}
    </div>
  );
}

export default StagePlaceholder;

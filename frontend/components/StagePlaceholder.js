// Stand-in for the three pipeline tabs until each is built: says what the
// tab will do instead of rendering an empty page. Replaced one tab at a time.
import React from 'react';
import styles from '../styles/AlphaPulldownTab.module.css';

const DESCRIPTIONS = {
  sequences: 'Search UniProt, paste or upload FASTA, or download a whole proteome, then choose the baits and candidates. This tab will also write the FASTA and protein-list files AlphaPulldown needs.',
  msa: 'Computes each protein\'s MSA and features with AlphaPulldown on CPU nodes, one Slurm array task per protein, and shows progress and timings.',
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

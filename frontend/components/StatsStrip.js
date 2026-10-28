// The numbers a user needs to judge whether a project is feasible: how many
// proteins, how many complexes would be folded, how many amino acids, how
// big the complexes get. Rendered from GET /projects/:id/stats (computed in
// backend/services/sequenceStats.js). Time and GPU/CPU-hour estimates join
// this strip once the speed database exists.
import React from 'react';
import styles from '../styles/StatsStrip.module.css';

function fmt(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString();
}

function buildTiles(stats) {
  const complexLength = stats.complexLength || {};
  const counts = {
    pulldown: [
      { label: 'Baits', value: stats.baits },
      { label: 'Candidates', value: stats.candidates },
      { label: 'Pairs', value: stats.pairs }
    ],
    all_vs_all: [
      { label: 'Proteins', value: stats.listed },
      { label: 'Pairs', value: stats.pairs }
    ],
    homo_oligomer: [
      { label: 'Proteins', value: stats.listed },
      { label: 'Complexes', value: stats.pairs }
    ]
  }[stats.mode] || [];

  return [
    ...counts,
    { label: 'Unique amino acids', value: stats.totalAA, hint: 'Residues of each distinct protein, counted once' },
    { label: 'Longest protein', value: stats.longestProtein, unit: 'aa' },
    { label: 'Median complex', value: complexLength.median, unit: 'aa', hint: 'Median length of the complexes to fold' },
    { label: 'Longest complex', value: complexLength.max, unit: 'aa' }
  ];
}

function StatsStrip({ stats }) {
  if (!stats) return <div className={styles.loading}>Loading statistics...</div>;

  return (
    <div className={styles.wrapper}>
      <div className={styles.strip}>
        {buildTiles(stats).map(tile => (
          <div key={tile.label} className={styles.tile} title={tile.hint}>
            <div className={styles.value}>
              {fmt(tile.value)}{tile.unit && tile.value !== null && tile.value !== undefined ? <span className={styles.unit}> {tile.unit}</span> : null}
            </div>
            <div className={styles.label}>{tile.label}</div>
          </div>
        ))}
      </div>
      {stats.uniqueProteins === 0 && (
        <p className={styles.hint}>No sequences yet - add them in the Sequences tab.</p>
      )}
      {stats.overLimit > 0 && (
        <p className={styles.warning}>
          {`${fmt(stats.overLimit)} of ${fmt(stats.pairs)} complexes are longer than ${fmt(stats.limitAA)} aa, `}
          which is unlikely to be feasible (limit set in Setup).
        </p>
      )}
    </div>
  );
}

export default StatsStrip;

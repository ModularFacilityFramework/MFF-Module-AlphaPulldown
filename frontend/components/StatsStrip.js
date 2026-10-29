// The numbers a user needs to judge whether a project is feasible: how many
// proteins, how many complexes would be folded, how many amino acids, how
// big the complexes get. Rendered from GET /projects/:id/stats (computed in
// backend/services/sequenceStats.js), together with the time and CPU/GPU-hour
// estimates the backend derives from its anonymised speed samples
// (backend/services/speedEstimator.js). The Sequences tab shows both stage
// estimates, the MSA and Co-folding tabs only their own.
import React from 'react';
import styles from '../styles/StatsStrip.module.css';

function fmt(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString();
}

const STAGE_ESTIMATES = {
  sequences: ['msa', 'fold'],
  msa: ['msa'],
  cofold: ['fold']
};
const ESTIMATE_LABELS = {
  msa: { title: 'MSA search', unit: 'CPU-hours' },
  fold: { title: 'Co-folding', unit: 'GPU-hours' }
};
const FAILED_SHARE_WARNING = 0.1;

function pct(share) {
  return `${Math.round(share * 100)}%`;
}

// Seconds as the two largest sensible units: 45 s, 12 min, 4 h 12 min, 2 d 3 h.
function formatDuration(seconds) {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

function formatHours(hours) {
  if (hours < 0.1) return '< 0.1';
  if (hours < 9.95) return hours.toFixed(1);
  return Math.round(hours).toLocaleString();
}

// One row of estimate tiles, or a single "no estimate yet" tile, per stage.
function buildEstimateRow(key, estimate) {
  const { title, unit } = ESTIMATE_LABELS[key];
  if (estimate.reason === 'empty') return null;
  if (!estimate.available) {
    return {
      key,
      tiles: [{
        label: `${title}: no estimate yet`,
        value: `${estimate.samples} of ${estimate.needed}`,
        hint: 'Finished jobs recorded so far. Every finished job adds its speed, and an estimate appears once enough are recorded.'
      }],
      warnings: []
    };
  }

  const min = estimate.lowerBound ? 'at least ' : '';
  const warnings = [];
  if (estimate.lowerBound) {
    warnings.push(`${title}: ${pct(estimate.extrapolatedShare)} of the jobs are larger than any measured so far, so these figures are a minimum.`);
  }
  if (estimate.failedShare >= FAILED_SHARE_WARNING) {
    warnings.push(`${title}: similar-sized jobs failed or ran out of memory about ${pct(estimate.failedShare)} of the time.`);
  }
  if (estimate.tier === 'method') {
    warnings.push(`${title}: based on runs on other hardware, so treat it as rough.`);
  }
  return {
    key,
    tiles: [
      {
        label: `${title} time`,
        value: `${min}${formatDuration(estimate.wallSeconds.typical)}`,
        sub: `slow case ${formatDuration(estimate.wallSeconds.slow)}`,
        hint: `Wall-clock time with ${estimate.slots} jobs at once, not counting time waiting in the queue. Slow case: every job at its 90th-percentile duration.`
      },
      {
        label: unit,
        value: `${min}${formatHours(estimate.resourceHours.typical)}`,
        sub: `slow case ${formatHours(estimate.resourceHours.slow)}`
      },
      {
        label: 'Longest job',
        value: formatDuration(estimate.longestJobSeconds.typical),
        sub: `slow case ${formatDuration(estimate.longestJobSeconds.slow)}`
      },
      {
        label: 'Confidence',
        value: estimate.confidence === 'good' ? 'Good' : 'Low',
        sub: `${estimate.samples.toLocaleString()} samples`,
        hint: 'Low under 30 recorded jobs, on other hardware, or when many jobs are outside the measured sizes.'
      }
    ],
    warnings
  };
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

function Tile({ tile }) {
  const text = typeof tile.value === 'string' ? tile.value : fmt(tile.value);
  return (
    <div className={styles.tile} title={tile.hint}>
      <div className={styles.value}>
        {text}{tile.unit && tile.value !== null && tile.value !== undefined ? <span className={styles.unit}> {tile.unit}</span> : null}
      </div>
      <div className={styles.label}>{tile.label}</div>
      {tile.sub && <div className={styles.sub}>{tile.sub}</div>}
    </div>
  );
}

function StatsStrip({ stats, stage }) {
  if (!stats) return <div className={styles.loading}>Loading statistics...</div>;

  const estimateRows = (STAGE_ESTIMATES[stage] || [])
    .map(key => buildEstimateRow(key, stats.estimates[key]))
    .filter(Boolean);

  return (
    <div className={styles.wrapper}>
      <div className={styles.strip}>
        {buildTiles(stats).map(tile => <Tile key={tile.label} tile={tile} />)}
      </div>
      {estimateRows.map(row => (
        <div key={row.key} className={`${styles.strip} ${styles.estimateStrip}`}>
          {row.tiles.map(tile => <Tile key={tile.label} tile={tile} />)}
        </div>
      ))}
      {estimateRows.flatMap(row => row.warnings).map(text => (
        <p key={text} className={styles.warning}>{text}</p>
      ))}
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

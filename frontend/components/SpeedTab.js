// Speed statistics (staff only): what the anonymised speed database holds and
// how much each estimate rests on. Read-only - the samples carry no names,
// users or projects, and nothing here can add, change or remove one. Rendered
// from GET /alphapulldown/speed/summary (backend/routes/speedRoutes.js).
import React, { useCallback, useEffect, useState } from 'react';
import { formatDuration } from './formatDuration';
import { errorText } from './runUi';
import styles from '../styles/SpeedTab.module.css';

const STAGE_TITLES = { msa: 'MSA search (CPU)', fold: 'Co-folding (GPU)' };
const LEVEL_TEXT = {
  none: { text: 'No estimate', className: 'levelNone', hint: 'Fewer than 5 finished samples: the stats strip gives no estimate for this class.' },
  low: { text: 'Low', className: 'levelLow', hint: '5 to 29 finished samples.' },
  good: { text: 'Good', className: 'levelGood', hint: '30 or more finished samples.' }
};

function fmt(value) {
  return Number(value).toLocaleString();
}

function seconds(value) {
  return value === null || value === undefined ? '—' : formatDuration(value);
}

function Tile({ value, label, sub }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileLabel}>{label}</div>
      {sub && <div className={styles.tileSub}>{sub}</div>}
    </div>
  );
}

function Overview({ summary }) {
  const total = summary.totals.msa.samples + summary.totals.fold.samples;
  return (
    <div className={styles.tiles}>
      <Tile value={fmt(total)} label="Samples recorded" sub={summary.firstDay ? `${summary.firstDay} to ${summary.lastDay}` : 'none yet'} />
      {Object.keys(STAGE_TITLES).map(stage => {
        const t = summary.totals[stage];
        const notFinished = t.oom + t.timeout + t.failed;
        return (
          <Tile
            key={stage}
            value={fmt(t.samples)}
            label={STAGE_TITLES[stage]}
            sub={t.samples > 0 ? `${fmt(t.ok)} finished, ${fmt(notFinished)} did not` : undefined}
          />
        );
      })}
    </div>
  );
}

function Activity({ activity }) {
  const peak = Math.max(1, ...activity.map(d => d.msa + d.fold));
  const total = activity.reduce((acc, d) => acc + d.msa + d.fold, 0);
  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>Samples recorded per day, last {activity.length} days</h4>
      {total === 0 ? (
        <p className={styles.muted}>Nothing recorded in this period.</p>
      ) : (
        <div className={styles.activity}>
          {activity.map(d => (
            <div
              key={d.day}
              className={styles.activityDay}
              title={`${d.day}: ${d.msa} MSA, ${d.fold} co-folding`}
            >
              <div className={styles.activityFold} style={{ height: `${(d.fold / peak) * 100}%` }} />
              <div className={styles.activityMsa} style={{ height: `${(d.msa / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
      <p className={styles.legend}>
        <span className={`${styles.swatch} ${styles.activityMsa}`} /> MSA
        <span className={`${styles.swatch} ${styles.activityFold}`} /> Co-folding
      </p>
    </div>
  );
}

function Bands({ bands }) {
  return (
    <table className={styles.bandTable}>
      <thead>
        <tr>
          <th>Size (aa)</th>
          <th className={styles.numeric}>Samples</th>
          <th className={styles.numeric}>Finished</th>
          <th className={styles.numeric}>Quickest quarter</th>
          <th className={styles.numeric}>Median</th>
          <th className={styles.numeric}>Slowest tenth</th>
        </tr>
      </thead>
      <tbody>
        {bands.map(b => (
          <tr key={b.label}>
            <td>{b.label}</td>
            <td className={styles.numeric}>{fmt(b.samples)}</td>
            <td className={styles.numeric}>{fmt(b.finished)}</td>
            <td className={styles.numeric}>{seconds(b.run && b.run.p25)}</td>
            <td className={styles.numeric}>{seconds(b.run && b.run.p50)}</td>
            <td className={styles.numeric}>{seconds(b.run && b.run.p90)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupRow({ group, open, onToggle }) {
  const level = LEVEL_TEXT[group.level];
  const notFinished = group.oom + group.timeout + group.failed;
  return (
    <>
      <tr className={styles.groupRow} onClick={onToggle}>
        <td>
          <button type="button" className={styles.toggle} aria-expanded={open} onClick={e => { e.stopPropagation(); onToggle(); }}>
            {open ? '▾' : '▸'}
          </button>
        </td>
        <td title={group.method}>{group.methodText}</td>
        <td title={group.hardware}>{group.hardwareText}</td>
        <td className={styles.numeric}>{fmt(group.samples)}</td>
        <td className={styles.numeric}>{fmt(group.finished)}</td>
        <td className={styles.numeric} title={`${group.oom} out of memory, ${group.timeout} timed out, ${group.failed} failed`}>
          {notFinished > 0 ? <span className={styles.failedText}>{fmt(notFinished)}</span> : '0'}
        </td>
        <td><span className={`${styles.badge} ${styles[level.className]}`} title={level.hint}>{level.text}</span></td>
        <td className={styles.numeric}>{seconds(group.run && group.run.p50)}</td>
        <td className={styles.numeric}>{seconds(group.run && group.run.p90)}</td>
        <td className={styles.numeric}>{seconds(group.queue && group.queue.p50)}</td>
        <td className={styles.numeric}>{fmt(group.minLength)} - {fmt(group.maxLength)}</td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={10} className={styles.bandCell}>
            <Bands bands={group.bands} />
            <p className={styles.muted}>
              Times are for finished jobs only. Queue time is the median wait before a job started (blank for MSA runs, which are timed per protein).
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function StageTable({ stage, groups }) {
  const [openKey, setOpenKey] = useState(null);
  const keyOf = g => `${g.method}|${g.hardware}`;
  return (
    <div className={styles.panel}>
      <h4 className={styles.panelTitle}>{STAGE_TITLES[stage]}</h4>
      {groups.length === 0 ? (
        <p className={styles.muted}>No samples yet. Each finished {stage === 'msa' ? 'MSA run' : 'co-folding pair'} adds one.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th />
                <th>What was run</th>
                <th>Where</th>
                <th className={styles.numeric}>Samples</th>
                <th className={styles.numeric}>Finished</th>
                <th className={styles.numeric}>Did not</th>
                <th>Confidence</th>
                <th className={styles.numeric}>Typical</th>
                <th className={styles.numeric}>Slow</th>
                <th className={styles.numeric}>Queue</th>
                <th className={styles.numeric}>Sizes (aa)</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <GroupRow
                  key={keyOf(g)}
                  group={g}
                  open={openKey === keyOf(g)}
                  onToggle={() => setOpenKey(openKey === keyOf(g) ? null : keyOf(g))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SpeedTab({ coreApi }) {
  const { api } = coreApi;
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return api.get('/alphapulldown/speed/summary')
      .then(res => { setSummary(res.data); setError(''); })
      .catch(err => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  if (!summary) return error ? <p className={styles.errorText}>{error}</p> : <div className={styles.muted}>Loading...</div>;

  const partial = Object.keys(STAGE_TITLES).filter(stage => summary.loaded[stage] < summary.totals[stage].samples);
  return (
    <div>
      <p className={styles.hint}>
        Every finished MSA run and co-folding pair adds one anonymous sample: sizes, a method label, a hardware label, how long it took and how it ended.
        No user, project, protein name or sequence is stored. These samples drive every estimate in the stats strip.
      </p>
      <div className={styles.controls}>
        <button type="button" className={styles.btnGray} onClick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
        {error && <span className={styles.errorText}>{error}</span>}
      </div>

      <Overview summary={summary} />
      <Activity activity={summary.activity} />

      {partial.length > 0 && (
        <p className={styles.warning}>
          The tables below use the newest {partial.map(stage => `${fmt(summary.loaded[stage])} of ${fmt(summary.totals[stage].samples)} ${STAGE_TITLES[stage]}`).join(' and ')} samples,
          which are the ones the estimates learn from. Older ones are still stored.
        </p>
      )}
      {summary.groupsOmitted > 0 && (
        <p className={styles.warning}>{fmt(summary.groupsOmitted)} smaller classes are not listed.</p>
      )}

      {Object.keys(STAGE_TITLES).map(stage => (
        <StageTable key={stage} stage={stage} groups={summary.groups.filter(g => g.stage === stage)} />
      ))}
      <p className={styles.muted}>
        A class is one method on one kind of hardware. An estimate only learns from its own class, so a class with no estimate needs more finished jobs of exactly that kind.
        Click a row for the timings by size.
      </p>
    </div>
  );
}

export default SpeedTab;

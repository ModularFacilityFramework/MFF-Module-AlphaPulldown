// Terminal-style viewer for a job's slurm.out / slurm.err: a fixed-height box
// with its own vertical scrollbar (so a long log never pushes the page down),
// kept scrolled to the newest line while it grows - unless the person has
// scrolled up to read something, in which case it stays exactly where they
// are until they scroll back to the bottom (or press "Latest").
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import styles from '../styles/LogViewer.module.css';

// Only the last MAX_LOG_LINES lines are put in the page. tqdm redraws and
// model logs can run to tens of thousands of lines; rendering all of them
// makes the tab sluggish for no benefit, since the newest are what matters
// while a job runs. The full file is always available from the Files tab.
const MAX_LOG_LINES = 5000;

// How close to the bottom (px) still counts as "at the bottom" - a scroll
// position a few pixels short (sub-pixel rounding, a partial last line)
// must not silently stop following.
const BOTTOM_SLACK_PX = 24;

function tailLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { shown: text, hidden: 0 };
  return { shown: lines.slice(-maxLines).join('\n'), hidden: lines.length - maxLines };
}

function LogViewer({ text }) {
  const boxRef = useRef(null);
  // Read inside the layout effect, which must not re-run when it changes,
  // hence a ref for the decision and state only for showing the button.
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const { shown, hidden } = useMemo(() => tailLines(text, MAX_LOG_LINES), [text]);

  // Runs after React has put the new text in the box and before the browser
  // paints, so following the tail never flashes the old position.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  }, [shown]);

  function handleScroll() {
    const box = boxRef.current;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX;
    followRef.current = atBottom;
    setFollowing(atBottom);
  }

  function jumpToLatest() {
    const box = boxRef.current;
    followRef.current = true;
    setFollowing(true);
    box.scrollTop = box.scrollHeight;
  }

  return (
    <div className={styles.wrap}>
      {hidden > 0 && (
        <p className={styles.notice}>
          Showing the last {MAX_LOG_LINES.toLocaleString()} lines ({hidden.toLocaleString()} earlier lines
          not shown) — download the full file from the Files tab.
        </p>
      )}
      <div className={styles.box} ref={boxRef} onScroll={handleScroll}>
        <pre className={styles.pre}>{shown}</pre>
      </div>
      {!following && (
        <button type="button" className={styles.latestButton} onClick={jumpToLatest}>
          ↓ Latest
        </button>
      )}
    </div>
  );
}

export default LogViewer;

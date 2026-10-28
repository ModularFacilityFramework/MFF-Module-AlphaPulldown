// What happened to the last "add sequences" action: how many went in and
// which ones were left out (bad residues, too short, already in the list)
// and why. The backend reports those instead of failing the whole request.
import React from 'react';
import styles from '../styles/SequencesTab.module.css';

function AddResultBanner({ result, onDismiss }) {
  if (!result) return null;

  const skipped = result.skipped || [];
  return (
    <>
      {result.error && (
        <div className={styles.errorBanner}>
          {result.error}
          {result.added > 0 && ` (${result.added} were added before this stopped.)`}
        </div>
      )}
      {!result.error && (
        <div className={result.added > 0 ? styles.successBanner : styles.warningBanner}>
          <div>
            {result.added > 0 ? `Added ${result.added.toLocaleString()} sequence${result.added === 1 ? '' : 's'}.` : 'Nothing was added.'}
            {result.skippedCount > 0 && ` ${result.skippedCount.toLocaleString()} skipped.`}
            {skipped.length > 0 && (
              <details className={styles.details}>
                <summary>Why were some skipped?</summary>
                <ul>
                  {skipped.map((s, i) => <li key={`${s.name}-${i}`}>{`${s.name}: ${s.reason}`}</li>)}
                </ul>
                {result.skippedCount > skipped.length && <div>{`...and ${(result.skippedCount - skipped.length).toLocaleString()} more.`}</div>}
              </details>
            )}
          </div>
          <button type="button" className={styles.bannerClose} onClick={onDismiss} aria-label="Dismiss">×</button>
        </div>
      )}
    </>
  );
}

export default AddResultBanner;

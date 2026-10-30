// Small helpers the MSA and Co-folding tabs share: how an error from the
// module's routes reads, how a Slurm state colours its badge, how a time shows.
const BAD_STATES = ['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'BOOT_FAIL', 'DEADLINE', 'SUBMIT_FAILED'];

export function errorText(err) {
  return err.response?.data?.error || err.message;
}

// styles: the CSS module that defines badgeGreen/badgeRed/badgeBlue/badgeGray.
export function badgeClass(styles, state) {
  const word = String(state).split(/[\s+]/)[0];
  if (word === 'COMPLETED') return styles.badgeGreen;
  if (BAD_STATES.includes(word)) return styles.badgeRed;
  if (word === 'RUNNING' || word === 'COMPLETING' || word === 'SUBMITTING') return styles.badgeBlue;
  return styles.badgeGray;
}

export function formatWhen(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

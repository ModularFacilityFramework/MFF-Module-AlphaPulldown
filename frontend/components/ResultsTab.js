// Results tab - a card per job (POST /abcfold/jobs creates AND submits in
// one request now, see RunTab.js - there's no more draft-review step), each
// opening into a tabbed detail view. status='draft' only ever means "created
// but failed to submit to Slurm" from here on - never an intentional pause -
// so it's shown as an error state with a Resubmit action, not a normal one.
// A job that reached Slurm and then finished (TERMINAL_STATES below -
// failed, cancelled, or even completed) gets the same Resubmit action, plus
// a shortcut back to Setup - both non-'draft' cases are otherwise ordinary,
// successfully-submitted jobs. Both the list view and an open job's detail
// view auto-poll GET /jobs/:id/status for anything still in flight, so a
// job failing (or finishing) shows up without a manual refresh.
//
// Resubmit and Clone both hand a job's own job.json (see
// abcfoldRoutes.js's JOB_PARAMS_FILENAME - the exact Run tab fields it was
// submitted with, read back via the existing GET /jobs/:id/download route,
// same as stdout/stderr) up to ABCFoldTab.js, which switches to the Run tab
// pre-filled with them - a real chance to review or edit before it runs
// again, not a blind rerun. They differ only in what happens on submit:
// Resubmit reuses this same job's row/workDir (POST /jobs/:id/submit,
// which wipes it clean first), Clone always creates a brand new one
// (ordinary POST /jobs) - see onEditJob/onCloneJob below.
import React, { useEffect, useRef, useState } from 'react';
import LogViewer from './LogViewer';
import styles from '../styles/ResultsTab.module.css';

// Chip color by status intent, per core's Module UI Guide (green/red/info/
// neutral). 'draft' is this module's own error state; the rest are the
// Slurm module's own state vocabulary, passed through verbatim from
// GET /jobs/:id/status - not invented here.
const STATUS_COLORS = {
  draft: '#dc3545',
  SUBMITTED: '#17a2b8',
  PENDING: '#6c757d',
  RUNNING: '#17a2b8',
  COMPLETED: '#28a745',
  FAILED: '#dc3545',
  CANCELLED: '#dc3545',
  TIMEOUT: '#dc3545',
  NODE_FAIL: '#dc3545',
  OUT_OF_MEMORY: '#dc3545',
  PREEMPTED: '#dc3545',
  DEADLINE: '#dc3545',
  BOOT_FAIL: '#dc3545'
};

// Slurm's own standard job-state vocabulary that means a job is done and
// safe to resubmit - as opposed to still queued/running. Duplicated in
// backend/routes/abcfoldRoutes.js (frontend and backend can't share a JS
// module directly in this architecture) - keep both lists in sync if this
// ever changes.
const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAIL', 'OUT_OF_MEMORY', 'PREEMPTED', 'DEADLINE', 'BOOT_FAIL'];

const TABS = [
  { key: 'script', label: 'sbatch script' },
  { key: 'stdout', label: 'stdout' },
  { key: 'stderr', label: 'stderr' },
  { key: 'report', label: 'Report' },
  { key: 'definition', label: 'Job definition' },
  { key: 'files', label: 'Files' }
];

// While a log tab is open on a job that's still in flight, slurm.out/err are
// re-read this often - the first fetch alone is only ever a snapshot of the
// first few seconds of a run (the real failure this replaced: a job's logs
// fetched once, 3 s after it started, then never again).
const LOG_POLL_MS = 3000;

// abcfold/tqdm output is hard to read or paste as-is: ANSI colour escapes
// show up as stray "[37m" text, and tqdm redraws its progress bar with bare
// carriage returns, which a <pre> glues into one multi-KB line. Strip the
// colours, and make every redraw its own line.
// eslint-disable-next-line no-control-regex
const ANSI_COLOR = /\x1b\[[0-9;]*m/g;
function cleanLog(text) {
  return text.replace(ANSI_COLOR, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// The Slurm module's status route hands back timestamps whose unit this
// module can't see (it only proxies them) - they were being rendered through
// `new Date(value)` directly, which treats a number as MILLISECONDS, so epoch
// SECONDS (1793129625) came out as 21/01/1970 19:05:29 for submitted/started/
// ended alike (they differ by only milliseconds when misread). Accept
// whichever shape arrives: a number below 1e11 is seconds (epoch seconds are
// ~1.8e9 now, epoch milliseconds ~1.8e12), a larger number is already
// milliseconds, a string is parsed as a date. Anything unusable (null, 0,
// "Unknown" for a job that hasn't ended) returns null so the row is hidden.
function formatSlurmTime(value) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const asNumber = typeof value === 'number' ? value : Number(value);
  const ms = Number.isFinite(asNumber) ? (asNumber < 1e11 ? asNumber * 1000 : asNumber) : Date.parse(value);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function ResultsTab({ coreApi, onGoToSetup, onEditJob, onCloneJob }) {
  const { api } = coreApi;
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('script');

  // Loading state shared by both Resubmit and Clone while job.json is
  // being fetched, before handing off to ABCFoldTab.js and switching away
  // from this tab entirely - there's nothing left to show once that
  // happens, so one flag/error pair covers both actions.
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramsError, setParamsError] = useState('');

  // Rerun stays on this detail view (unlike Resubmit/Clone, which navigate
  // away), so it needs its own loading/error pair rather than sharing
  // paramsLoading/paramsError.
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState('');

  // Delete has its own inline two-step confirm (no modal library exists
  // anywhere in this codebase) - confirmingDelete just tracks whether the
  // "Really delete?" step is showing, reset on every fresh viewJob() so it
  // never carries over from one job's detail view into another's.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const [statusInfo, setStatusInfo] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  // null = not fetched yet, '' = fetched and genuinely empty - distinct
  // states so the tab can tell "still loading" apart from "loaded, nothing
  // there".
  const [stdout, setStdout] = useState(null);
  const [stdoutLoading, setStdoutLoading] = useState(false);
  const [stdoutError, setStdoutError] = useState('');
  const [stderrText, setStderrText] = useState(null);
  const [stderrLoading, setStderrLoading] = useState(false);
  const [stderrError, setStderrError] = useState('');

  // Which job's detail view is open right now, readable from inside a
  // request that's already in flight - a log response that lands after the
  // user has gone back to the list (or opened a different job) must not
  // overwrite what's now on screen. With logs re-read every few seconds
  // that overlap is a real case, not a theoretical one.
  const selectedJobId = selectedJob ? selectedJob.id : null;
  const selectedIdRef = useRef(null);
  useEffect(() => {
    selectedIdRef.current = selectedJobId;
  }, [selectedJobId]);

  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');

  // reportUrl: where the Report iframe points (a ticketed URL into this
  // job's own output folder - see the report routes in abcfoldRoutes.js), or
  // null if not loaded/no report exists. reportError 'none' is a sentinel for
  // "ABCFold wrote no index.html for this job" - distinct from a real
  // failure, so the tab can show an accurate empty-state message either way.
  const [reportUrl, setReportUrl] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  // True when job.json says the job was run with "Skip visualizations" - the
  // one case where a finished job has no report by the user's own choice.
  const [reportSkipped, setReportSkipped] = useState(false);
  const [reportError, setReportError] = useState('');

  // Cards only ever show whatever status was last fetched - a job that
  // finishes (or fails) between one load and the next otherwise just sits
  // showing stale SUBMITTED/PENDING/RUNNING forever until someone happens
  // to open it. After the list loads, re-check every job that isn't
  // already 'draft' or terminal, updating each card in place as answers
  // come back - a handful of individual GET .../status calls, fine at the
  // scale of one person's own job list.
  function refreshJobsNeedingStatus(jobList) {
    jobList
      .filter(job => job.status !== 'draft' && !TERMINAL_STATES.includes(job.status))
      .forEach(job => {
        api.get(`/abcfold/jobs/${job.id}/status`)
          .then(res => setJobs(current => current.map(j => (j.id === job.id ? { ...j, status: res.data.state } : j))))
          .catch(() => {});
      });
  }

  function loadJobs() {
    setLoading(true);
    api.get('/abcfold/jobs')
      .then(res => {
        setJobs(res.data);
        refreshJobsNeedingStatus(res.data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  function refreshStatus(id) {
    setStatusLoading(true);
    setStatusError('');
    api.get(`/abcfold/jobs/${id}/status`)
      .then(res => {
        setStatusInfo(res.data);
        // The badge (and the polling stop-condition below) read
        // selectedJob.status, not statusInfo - without this, a refresh
        // that finds a job just finished would update the detail grid but
        // leave the badge (and polling) stuck on the old in-flight status.
        setSelectedJob(current => (current ? { ...current, status: res.data.state } : current));
        setJobs(current => current.map(j => (j.id === id ? { ...j, status: res.data.state } : j)));
      })
      .catch(err => setStatusError(err.response?.data?.message || err.message))
      .finally(() => setStatusLoading(false));
  }

  function refreshFiles(id) {
    setFilesLoading(true);
    setFilesError('');
    return api.get(`/abcfold/jobs/${id}/files`)
      .then(res => { setFiles(res.data); return res.data; })
      .catch(err => { setFilesError(err.response?.data?.message || err.message); return []; })
      .finally(() => setFilesLoading(false));
  }

  // Shared by the stdout/stderr tabs - both are just a named file read
  // straight from the job's own workDir, same as everything else in
  // "Files", just fetched eagerly as text instead of downloaded on click.
  // A 404 (job hasn't produced that file yet) reads as "nothing there",
  // not an error. `silent` is for the background re-reads of a running job's
  // logs: no loading flag (the panel keeps showing the last content instead
  // of flickering to "Loading..." every few seconds), and a failed re-read
  // is ignored rather than replacing good content with an error.
  function loadTextFile(id, filename, setContent, setLoadingState, setErrorState, silent = false) {
    if (!silent) {
      setLoadingState(true);
      setErrorState('');
    }
    api.get(`/abcfold/jobs/${id}/download`, { params: { file: filename }, responseType: 'text' })
      .then(res => {
        if (selectedIdRef.current !== id) return;
        setContent(typeof res.data === 'string' ? cleanLog(res.data) : '');
        if (silent) setErrorState('');
      })
      .catch(err => {
        if (selectedIdRef.current !== id) return;
        if (err.response?.status === 404) setContent('');
        else if (!silent) setErrorState('Failed to load file');
      })
      .finally(() => {
        if (!silent) setLoadingState(false);
      });
  }

  // (Re)reads one of the two log files for the open job. Every caller goes
  // through here so stdout/stderr can never drift apart in how they're loaded.
  function reloadLog(tab, silent) {
    if (!selectedJob) return;
    if (tab === 'stdout') loadTextFile(selectedJob.id, 'slurm.out', setStdout, setStdoutLoading, setStdoutError, silent);
    if (tab === 'stderr') loadTextFile(selectedJob.id, 'slurm.err', setStderrText, setStderrLoading, setStderrError, silent);
  }

  function loadReport(id, currentFiles) {
    // ABCFold writes index.html only when visualizations are on, so its
    // absence is an answer, not an error.
    if (!currentFiles.includes('index.html')) {
      setReportError('none');
      setReportSkipped(false);
      loadJobParams(id)
        .then(result => {
          if (selectedIdRef.current === id) setReportSkipped(result.status === 'found' && !!result.params.noVisuals);
        })
        .catch(() => {});
      return;
    }
    setReportLoading(true);
    setReportError('');
    api.post(`/abcfold/jobs/${id}/report-ticket`)
      .then(res => {
        if (selectedIdRef.current !== id) return;
        setReportUrl(api.getUri({ url: `/abcfold/jobs/${id}/report/${res.data.ticket}/${res.data.entry}` }));
      })
      .catch(err => {
        if (selectedIdRef.current !== id) return;
        setReportError(err.response?.status === 404 ? 'none' : 'Failed to load report');
      })
      .finally(() => setReportLoading(false));
  }

  function selectTab(tab) {
    setActiveTab(tab);
    // Always re-read a log tab when it's opened (this used to load only
    // while the state was still null, so the first snapshot - taken seconds
    // into a run - was shown forever). If there's already content from an
    // earlier visit, keep showing it while the fresh copy loads, instead of
    // flashing "Loading...".
    if (tab === 'stdout') reloadLog('stdout', stdout !== null);
    if (tab === 'stderr') reloadLog('stderr', stderrText !== null);
    // Every visit to Report starts from scratch: a fresh file list (the
    // report may have appeared since the job was opened) and a fresh ticket
    // (they expire after 30 idle minutes), instead of reusing a stale URL.
    if (tab === 'report' && selectedJob) {
      setReportUrl(null);
      setReportError('');
      refreshFiles(selectedJob.id);
    }
    // Report isn't triggered here directly - it needs `files` to already be
    // loaded to know whether a .html file exists at all, and that fetch may
    // still be in flight (kicked off by viewJob) when this tab is clicked.
    // The effect below reacts once filesLoading actually clears, instead of
    // this concluding "no report" prematurely off an empty in-flight list.
  }

  useEffect(() => {
    if (!selectedJob || activeTab !== 'report' || filesLoading || reportUrl !== null || reportError) return;
    loadReport(selectedJob.id, files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob, activeTab, filesLoading, files, reportUrl, reportError]);

  // Auto-poll while the open job is still in flight, so a job that fails
  // (or finishes) while someone's looking at it updates on its own instead
  // of needing a manual "Refresh status" click. Stops itself the moment
  // the status is 'draft' or terminal - depends on id/status specifically
  // (not the whole selectedJob object, which refreshStatus replaces on
  // every poll) so the interval isn't torn down and rebuilt every 15s for
  // no reason.
  useEffect(() => {
    if (!selectedJob || selectedJob.status === 'draft' || TERMINAL_STATES.includes(selectedJob.status)) return undefined;
    const interval = setInterval(() => refreshStatus(selectedJob.id), 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJob?.id, selectedJob?.status]);

  // Live logs: while a log tab is open on a job that's still in flight, keep
  // re-reading it (silently - see loadTextFile). Same stop conditions as the
  // status poll above: gone the moment the job is draft/terminal, the tab
  // changes, or a different job is opened.
  const onLogTab = activeTab === 'stdout' || activeTab === 'stderr';
  const jobInFlight = !!selectedJob && selectedJob.status !== 'draft' && !TERMINAL_STATES.includes(selectedJob.status);
  useEffect(() => {
    if (!jobInFlight || !onLogTab) return undefined;
    const interval = setInterval(() => reloadLog(activeTab, true), LOG_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobInFlight, activeTab]);

  // One last read the moment the open job reaches a terminal state, so the
  // final lines (usually the actual error) are never missed between the last
  // poll and the job ending.
  const openJobStatus = selectedJob ? selectedJob.status : null;

  // Which tab a job opens on follows its state: stdout while it runs, the
  // report once it has finished (the script for a job never submitted). It
  // keeps following the state - a job that finishes while open flips from
  // stdout to the report - until the person picks a tab themselves, after
  // which their choice stays put. Opening another job, or a Rerun, starts
  // following again.
  const tabPickedRef = useRef(false);
  useEffect(() => {
    if (!selectedJobId || !openJobStatus || tabPickedRef.current) return;
    let wanted = 'stdout';
    if (openJobStatus === 'draft') wanted = 'script';
    else if (TERMINAL_STATES.includes(openJobStatus)) wanted = 'report';
    if (wanted !== activeTab) selectTab(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, openJobStatus]);
  useEffect(() => {
    if (!openJobStatus || !TERMINAL_STATES.includes(openJobStatus) || !onLogTab) return;
    reloadLog(activeTab, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, openJobStatus]);

  function viewJob(id) {
    setDetailLoading(true);
    setParamsError('');
    setRerunError('');
    setConfirmingDelete(false);
    setDeleteError('');
    tabPickedRef.current = false;
    setActiveTab('script');
    setStatusInfo(null);
    setStdout(null);
    setStdoutError('');
    setStderrText(null);
    setStderrError('');
    setFiles([]);
    setReportUrl(null);
    setReportError('');
    api.get(`/abcfold/jobs/${id}`)
      .then(res => {
        setSelectedJob(res.data);
        if (res.data.slurm_job_id) {
          refreshStatus(id);
          refreshFiles(id);
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setDetailLoading(false));
  }

  // Reads a job's own job.json back (written by submitJobToSlurm() next to
  // submit.sh/the input JSON - see abcfoldRoutes.js) via the same generic
  // download route everything else in this tab already uses. Not gated on
  // slurm_job_id having ever been set - a job stuck in 'draft' because the
  // Slurm call itself failed can still have a real job.json on disk from
  // before that call. A 404 (job predates this feature, or never got far
  // enough to write it) resolves { status: 'not_found' } rather than
  // rejecting - that's a legitimate, expected outcome the Run tab needs to
  // show a real "couldn't restore, fill in manually" message for, not
  // silence. A genuine failure (network error, 500, anything that isn't
  // "this file doesn't exist") still rejects, so it surfaces through
  // paramsError below instead of being mistaken for "nothing to restore".
  function loadJobParams(id) {
    return api.get(`/abcfold/jobs/${id}/download`, { params: { file: 'job.json' }, responseType: 'text' })
      .then(res => {
        try {
          return { status: 'found', params: JSON.parse(res.data) };
        } catch (parseErr) {
          return { status: 'not_found' };
        }
      })
      .catch(err => {
        if (err.response?.status === 404) return { status: 'not_found' };
        throw err;
      });
  }

  function handleResubmit() {
    setParamsLoading(true);
    setParamsError('');
    const id = selectedJob.id;
    loadJobParams(id)
      .then(result => onEditJob(result, id))
      .catch(err => setParamsError(err.response?.data?.message || err.message))
      .finally(() => setParamsLoading(false));
  }

  function handleClone() {
    setParamsLoading(true);
    setParamsError('');
    loadJobParams(selectedJob.id)
      .then(result => onCloneJob(result))
      .catch(err => setParamsError(err.response?.data?.message || err.message))
      .finally(() => setParamsLoading(false));
  }

  // Rerun: same job, same parameters, immediately - no Run tab detour at
  // all, unlike Resubmit. Only possible when job.json actually exists
  // (loadJobParams's 'found' case) - there's nothing to instantly rerun
  // with otherwise (a job predating this module's job.json feature, e.g.),
  // and that's a real, honest limitation, not a bug to work around.
  function handleRerun() {
    setRerunning(true);
    setRerunError('');
    const id = selectedJob.id;
    loadJobParams(id)
      .then(result => {
        if (result.status === 'not_found') {
          setRerunError('No saved parameters to rerun with — use Resubmit instead.');
          return null;
        }
        // Stale tab caches: this overwrites the same job's own folder, so
        // its previous run's stdout/stderr/report must not linger - same
        // reasoning as Resubmit's own folder-wipe on the backend side.
        setStdout(null);
        setStdoutError('');
        setStderrText(null);
        setStderrError('');
        setReportUrl(null);
        setReportError('');
        tabPickedRef.current = false;
        return api.post(`/abcfold/jobs/${id}/submit`, result.params);
      })
      .then(res => {
        if (!res) return;
        setSelectedJob(res.data);
        setJobs(current => current.map(j => (j.id === res.data.id ? { ...j, status: res.data.status } : j)));
        refreshStatus(res.data.id);
        refreshFiles(res.data.id);
      })
      .catch(err => setRerunError(err.response?.data?.message || err.response?.data?.error || err.message))
      .finally(() => setRerunning(false));
  }

  function handleDelete() {
    setDeleting(true);
    setDeleteError('');
    const id = selectedJob.id;
    api.delete(`/abcfold/jobs/${id}`)
      .then(() => { setSelectedJob(null); loadJobs(); })
      .catch(err => {
        setConfirmingDelete(false);
        setDeleteError(err.response?.data?.message || err.response?.data?.error || err.message);
        // 409 means this detail view's own cached status is stale - the
        // job actually started running again since it was last checked.
        // Refresh so the badge (and the isDraft/isTerminal gate that
        // showed the Delete button at all) catch up to reality.
        if (err.response?.status === 409) refreshStatus(id);
      })
      .finally(() => setDeleting(false));
  }

  function downloadFile(filename) {
    api.get(`/abcfold/jobs/${selectedJob.id}/download`, { params: { file: filename }, responseType: 'blob' })
      .then(res => {
        const url = window.URL.createObjectURL(new Blob([res.data]));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      })
      .catch(() => setFilesError('Failed to download file'));
  }

  // One status-grid row for a Slurm timestamp, or nothing when there's no
  // usable value (see formatSlurmTime).
  function timeRow(label, value) {
    const text = formatSlurmTime(value);
    return text ? <><dt>{label}</dt><dd>{text}</dd></> : null;
  }

  // Shared by the stdout/stderr tabs. text === null means "never loaded";
  // '' means loaded and genuinely empty. "Loading..." only shows while
  // there's nothing to show yet - a refresh keeps the current content on
  // screen, and a failed refresh is shown above it rather than replacing it.
  function renderLog(tab, text, isLoading, errorMsg, emptyMsg) {
    return (
      <>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => reloadLog(tab, false)}
          disabled={isLoading}
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
        {jobInFlight && <span className={styles.hint}> live — updates every {LOG_POLL_MS / 1000}s</span>}
        {errorMsg && <p className={styles.fieldError}>{errorMsg}</p>}
        {text === null
          ? (isLoading ? <p className={styles.loading}>Loading...</p> : null)
          : (text === '' ? <p className={styles.empty}>{emptyMsg}</p> : <LogViewer text={text} />)}
      </>
    );
  }

  function statusBadge(status) {
    return (
      <span className={styles.statusBadge} style={{ backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.draft }}>
        {status}
      </span>
    );
  }

  if (selectedJob) {
    const isDraft = selectedJob.status === 'draft';
    const isTerminal = TERMINAL_STATES.includes(selectedJob.status);
    // Finished, the folder listing has genuinely loaded (it always contains
    // at least submit.sh), and neither Slurm log is in it - see the banner
    // below. files.length > 0 matters: before the listing arrives it's [].
    const neverStarted = isTerminal && !filesLoading && !filesError && files.length > 0
      && !files.includes('slurm.out') && !files.includes('slurm.err');
    return (
      <div className={styles.detail}>
        <button type="button" className={styles.backButton} onClick={() => setSelectedJob(null)}>&larr; Back to list</button>
        <h4>{`J${selectedJob.job_number} — ${selectedJob.name}`}</h4>
        {statusBadge(selectedJob.status)}

        {!isDraft && (
          <>
            <button type="button" className={styles.refreshButton} onClick={() => refreshStatus(selectedJob.id)} disabled={statusLoading}>
              {statusLoading ? 'Refreshing...' : 'Refresh status'}
            </button>
            {!isTerminal && (
              // No scancel-equivalent exists in the Slurm module's own
              // external API today (confirmed against
              // docs/MFF-Module-SLURM_slurm-config.md - it lists exactly
              // four routes, none of them a cancel route) - an honest note
              // instead of a dead/disabled button that would read as a bug.
              // Swap this for a real Cancel button once that route exists.
              <p className={styles.hint}>
                Cancelling a running job isn&apos;t supported yet — this needs a change on the Slurm module&apos;s side.
              </p>
            )}
            {statusError && <p className={styles.fieldError}>{statusError}</p>}
            {statusInfo && (
              <dl className={styles.statusGrid}>
                <dt>State</dt><dd>{statusInfo.state}</dd>
                {statusInfo.reason && <><dt>Reason</dt><dd>{statusInfo.reason}</dd></>}
                {statusInfo.exitCode !== undefined && <><dt>Exit code</dt><dd>{statusInfo.exitCode}</dd></>}
                {timeRow('Submitted', statusInfo.submittedAt)}
                {timeRow('Started', statusInfo.startedAt)}
                {timeRow('Ended', statusInfo.endedAt)}
              </dl>
            )}
            {neverStarted && (
              // A job that actually ran always leaves slurm.out and slurm.err
              // in its folder (Slurm opens both before it starts the script).
              // Neither exists here although the folder listing has loaded -
              // so the script never started and there is no log to wait for;
              // the stdout/stderr tabs would otherwise just say "No output
              // yet." and leave no clue why.
              <p className={styles.errorBanner}>
                Slurm ended this job without ever starting its script: no slurm.out or slurm.err was
                created, so there is no log to show. Slurm reported {selectedJob.status}
                {statusInfo && statusInfo.exitCode !== undefined ? `, exit code ${statusInfo.exitCode}` : ''}
                {statusInfo && statusInfo.reason && statusInfo.reason !== 'None' ? `, reason ${statusInfo.reason}` : ''}.
              </p>
            )}
          </>
        )}

        {(isDraft || isTerminal) && (
          <p className={styles.submissionNote}>
            {isDraft ? 'This job failed to submit to Slurm.' : `This job has finished (${selectedJob.status}).`}
            {' '}Resubmit and Clone both go to the Run tab to review or edit first; Rerun runs it again
            immediately, unchanged.
          </p>
        )}

        <div className={styles.actionRow}>
          {(isDraft || isTerminal) && (
            <>
              <button type="button" className={styles.submitButton} onClick={handleResubmit} disabled={paramsLoading}>
                {paramsLoading ? 'Loading...' : 'Resubmit'}
              </button>
              <button type="button" className={styles.refreshButton} onClick={handleRerun} disabled={rerunning}>
                {rerunning ? 'Rerunning...' : 'Rerun'}
              </button>
            </>
          )}
          <button type="button" className={styles.refreshButton} onClick={handleClone} disabled={paramsLoading}>
            {paramsLoading ? 'Loading...' : 'Clone'}
          </button>
          {(isDraft || isTerminal) && onGoToSetup && (
            <button type="button" className={styles.refreshButton} onClick={onGoToSetup}>
              Go to Setup
            </button>
          )}
          {(isDraft || isTerminal) && (
            confirmingDelete ? (
              <>
                <button type="button" className={styles.dangerButton} onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : `Really delete J${selectedJob.job_number}?`}
                </button>
                <button type="button" className={styles.refreshButton} onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className={styles.refreshButton} onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )
          )}
        </div>

        {paramsError && <p className={styles.fieldError}>{paramsError}</p>}
        {rerunError && <p className={styles.fieldError}>{rerunError}</p>}
        {deleteError && <p className={styles.fieldError}>{deleteError}</p>}

        <div className={styles.tabBar}>
          {TABS.map(tab => (
            <button
              key={tab.key}
              type="button"
              className={activeTab === tab.key ? styles.tabButtonActive : styles.tabButton}
              onClick={() => { tabPickedRef.current = true; selectTab(tab.key); }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.tabPanel}>
          {activeTab === 'script' && <pre className={styles.pre}>{selectedJob.sbatch_script}</pre>}

          {activeTab === 'stdout' && renderLog('stdout', stdout, stdoutLoading, stdoutError,
            jobInFlight ? 'No output yet.' : 'Nothing was written to stdout.')}

          {activeTab === 'stderr' && renderLog('stderr', stderrText, stderrLoading, stderrError,
            jobInFlight ? 'No error output yet.' : 'Nothing was written to stderr.')}

          {activeTab === 'report' && (
            reportLoading ? <p className={styles.loading}>Loading...</p>
              : reportError === 'none' ? (
                <p className={styles.empty}>
                  {jobInFlight
                    ? 'No report yet — ABCFold writes it when the job finishes.'
                    : reportSkipped
                      ? 'No report: this job was run with "Skip visualizations" ticked, so ABCFold did not create one. Use Resubmit, untick it, and run again.'
                      : 'ABCFold did not write a report for this job (it only writes one when at least one model produced a structure). Check the stdout and stderr tabs.'}
                </p>
              )
                : reportError ? <p className={styles.fieldError}>{reportError}</p>
                  : reportUrl
                    ? <iframe className={styles.reportFrame} src={reportUrl} sandbox="allow-same-origin allow-scripts allow-popups allow-downloads" title="ABCFold report" />
                    : <p className={styles.empty}>No report found for this job.</p>
          )}

          {activeTab === 'definition' && (
            <>
              <h5>Input JSON</h5>
              <pre className={styles.pre}>{selectedJob.input_json}</pre>
              <h5>abcfold command</h5>
              <pre className={styles.pre}>{selectedJob.abcfold_command}</pre>
            </>
          )}

          {activeTab === 'files' && (
            filesError ? <p className={styles.fieldError}>{filesError}</p>
              : filesLoading ? <p className={styles.loading}>Loading...</p>
                : files.length === 0 ? <p className={styles.empty}>No files yet.</p>
                  : (
                    <ul className={styles.fileList}>
                      {files.map(f => (
                        <li key={f}>
                          <span>{f}</span>
                          <button type="button" className={styles.viewButton} onClick={() => downloadFile(f)}>Download</button>
                        </li>
                      ))}
                    </ul>
                  )
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div className={styles.loading}>Loading...</div>;
  if (error) return <div className={styles.errorBanner}>{error}</div>;

  return (
    <div className={styles.list}>
      {jobs.length === 0 ? (
        <p className={styles.empty}>No jobs yet — create one in the Run tab.</p>
      ) : (
        <div className={styles.cardGrid}>
          {jobs.map(job => (
            <div
              key={job.id}
              className={styles.card}
              role="button"
              tabIndex={0}
              onClick={() => viewJob(job.id)}
              onKeyDown={e => { if (e.key === 'Enter') viewJob(job.id); }}
            >
              <div className={styles.cardTitle}>{`J${job.job_number} — ${job.name}`}</div>
              {statusBadge(job.status)}
              <div className={styles.cardMeta}>{job.models_selected}</div>
              <div className={styles.cardMeta}>{new Date(job.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
      {detailLoading && <p className={styles.loading}>Loading...</p>}
    </div>
  );
}

export default ResultsTab;

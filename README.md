# AlphaPulldown

An [MFF-core](../mff-core) feature module for running AlphaPulldown jobs on a Slurm cluster. Users define their inputs in the UI; this module generates the job's input files and sbatch script, writes them into the user's core workspace, and submits the job to the Slurm module.

> **Status: in development.** The module is built in phases: (0) project shell, settings and statistics, done; (1) Sequences tab (UniProt search, FASTA, proteome download and browsing, selection, AlphaPulldown files), done; (2) anonymised speed database and estimates in the stats strip, done (estimates read "no estimate yet" until the MSA and Co-folding tabs have recorded finished jobs); (3) MSA (CPU) tab, done; (4) Co-folding (GPU) tab through the ABCFold module, done (it assumes the ABCFold module's API, which is not documented yet - see the Co-folding section); (5) staff speed-statistics view and polish, not built.

## Quick start

```bash
nvm use
npm install
git config core.hooksPath .githooks   # enables the version-bump pre-commit hook
```

This repo has no local dev harness - real testing happens by installing it into a real mff-core checkout (see below).

## Structure

```
module.manifest.json    # id, label, version, tablePrefix, mountPath - single source of truth
backend/                 # this module's real Express router + own DB tables
frontend/                 # this module's real React components
docs/                       # symlink to mff-core's own docs/ - a shared space core and every module
                            # link to. The coreApi contract, manifest schema, UI guide, and
                            # install/database-provisioning docs are core's own MFF-Core_*.md
                            # files in that shared folder, not duplicated here.
```

## MSA stage

The MSA (CPU) tab runs AlphaPulldown's `create_individual_features.py` for the project's distinct proteins. A run is **one Slurm job** (not a job array): its script searches `Proteins searched at once` proteins in parallel with `xargs -P` inside a single allocation, so it asks for that many times the per-protein CPUs and memory, and a time limit of the per-protein limit times the number of rounds. Setup holds those numbers, the environment and the database directory (or MMseqs2); nothing about the cluster is assumed. A job array would let Slurm place each protein separately, but the Slurm module's array handling is unconfirmed (`requests/S1-slurm-array-jobs.md`).

Each run has its own folder, `module-AlphaPulldown/P<n>/msa/run-<id>/`, in the user's workspace: `submit.sh`, `run_one.sh`, `msa_input.fasta`, `msa_names.txt`, `msa_lengths.txt`, `timings.tsv`, and one log per protein in `logs/`. Feature files go to `P<n>/features/`, shared by every run of the project. A protein whose features already exist is skipped (unless "search again" is ticked), and failures are reported by name with their log. `timings.tsv` records index, length, seconds, exit code and status - no names - and is copied into the anonymised speed database the first time the run is seen finished.

## Co-folding stage

The Co-folding (GPU) tab folds every bait-candidate pair (or, for the other modes, every pair of two proteins, or each protein alone for a homo-oligomer) with **one ABCFold job per pair**, created through the ABCFold module with `coreApi.callModule(token, 'abcfold', ...)` and the calling user's own token. The tab plans a run first: how many pairs, how many are already folded or held back for size (over `warn_max_complex_aa`), an estimate from the speed samples filed under the same options, and the first few pairs. A run holds at most 5,000 pairs; narrow a bigger selection by bait or with a limit. Options: model seeds, GPUs per pair, MSA search (leave to the ABCFold module, MMseqs2 server, or local database), templates, and handing over the MSAs from the MSA tab.

**There is no background process.** A run advances only while its owner has the page open: each time the tab loads the run list, it refreshes the submitted pairs from ABCFold, ingests the finished ones into the speed database (once each), and submits queued pairs while fewer than `Co-folding jobs in flight` (Setup) are running. Close the page and nothing more is submitted until it is opened again; jobs already submitted keep running on the cluster. The tab says so. A pair that cannot be submitted is retried up to three times, then marked SUBMIT_FAILED (one failure stops that round, so a missing ABCFold module is one message, not hundreds). "Retry failed" puts failed pairs back in the queue; "Cancel" drops the queued ones and cancels the submitted ones in Slurm (through the Slurm module, using the Slurm job id ABCFold answered with).

**The ABCFold API is assumed, not documented** (`requests/A2-abcfold-documented-external-surface.md`). `backend/services/abcfoldClient.js` is the only place that knows it: `POST /jobs` with name, `sequences` (`{type, id, sequence}`, one chain per copy), `modelSeeds`, `models: ['alphafold3']`, `templates`, `gpuCount` and optionally `mmseqs2`, answering `{id, status, slurm_job_id}`; `GET /jobs/:id/status` answering `state`, `submittedAt`, `startedAt`, `endedAt`. If the real module differs, change that file.

**MSA reuse needs two things that do not exist yet.** The ABCFold module must accept a per-chain MSA path (`requests/A1-abcfold-per-chain-msa.md`; until then it ignores the field and searches for its own). And the MSA stage only leaves a usable file when it searched with MMseqs2: AlphaPulldown writes `<features>/<name>.a3m` then, while a local search leaves AlphaFold2's own formats in a folder, which are not an A3M. The tab passes the path only for a regular `<name>.a3m` file (never a symlink or a folder), and only when the "hand over" box is ticked.

Each pair's end state becomes one speed sample (stage `fold`, both lengths, method label such as `s2-mmseqs2`, hardware `gpu<N>`, run and queue seconds from the Slurm timestamps ABCFold reports, outcome ok/oom/timeout/failed). Cancelled and never-submitted pairs give no sample.

## Speed estimates

Every finished MSA or co-folding job adds one anonymised row to `alphapulldown_speed_samples`: sizes in amino acids, a method label, a hardware label, run and queue seconds, an outcome and the day. No user, project, job, protein name, accession or sequence is stored, and there is no route that lets a client write to the table - only the module's own backend does, from jobs it observed. The stats strip turns those samples into a typical and a slow-case wall time and CPU/GPU-hours, with a confidence level:

- fewer than 5 finished samples: no estimate, just how many have been recorded
- 5 to 29: low confidence; 30 or more: good
- confidence also drops to low when the estimate borrows samples from other hardware, or when many jobs are larger than anything measured (the figures are then shown as a minimum)
- similar-sized jobs that failed or ran out of memory are reported as a warning

## Installing into a real mff-core checkout

Clone this repo to `App_frontend/src/core/alphapulldown/` inside a real mff-core checkout (or use Install on Preferences → Modules). This module's id, `alphapulldown`, must match that folder name.

Install provisions this module's own database and user, generates a random password, and writes `MODULE_ALPHAPULLDOWN_DB_HOST`/`_USER`/`_PASSWORD`/`_NAME` into `App_backend/.env` itself - nothing for an admin to type. Full mechanism: `docs/MFF-Core_module-database-provisioning.md`. The Slurm and ABCFold modules (`requires: ["slurm", "abcfold"]` in the manifest) must be installed first, and a dedicated `GRANT ... ON mff_module_alphapulldown.*` line may be needed once per deployment - see that same doc's provisioning section.

Restart core's backend afterwards so it picks up the new `.env` values.

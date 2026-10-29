# AlphaPulldown

An [MFF-core](../mff-core) feature module for running AlphaPulldown jobs on a Slurm cluster. Users define their inputs in the UI; this module generates the job's input files and sbatch script, writes them into the user's core workspace, and submits the job to the Slurm module.

> **Status: in development.** The module is built in phases: (0) project shell, settings and statistics, done; (1) Sequences tab (UniProt search, FASTA, proteome download and browsing, selection, AlphaPulldown files), done; (2) anonymised speed database and estimates in the stats strip, done (estimates read "no estimate yet" until the MSA and Co-folding tabs have recorded finished jobs); (3) MSA (CPU) tab, done; (4) Co-folding (GPU) tab through the ABCFold module. The Co-folding tab currently shows a "not built yet" notice.

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

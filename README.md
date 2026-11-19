# AlphaPulldown

An [MFF-core](../mff-core) feature module for running [AlphaPulldown](https://github.com/KosinskiLab/AlphaPulldown) (v2.x, AlphaFold 3 backend) pulldown screens on a Slurm cluster. Users pick a bait set and a candidate set in the UI; this module writes the input files and `sbatch` scripts into the user's core workspace, submits them through the Slurm module, and shows the scores of the finished predictions. If you use AlphaPulldown in published work, cite AlphaPulldown2 (Bioinformatics 2025, doi:10.1093/bioinformatics/btaf115).

Tabs: **Sequences** (UniProt search, FASTA, proteomes, bait/candidate selection, `baits.txt`/`candidates.txt`) - **Features (CPU)** - **Prediction (GPU)** - **Results** - **Setup** - and, for staff, **Speed statistics** and **Page Access**.

## Quick start

```bash
nvm use            # Node 20
npm install
git config core.hooksPath .githooks   # enables the version-bump pre-commit hook
npm test && npm run lint
```

This repo has no local dev harness - real testing happens by installing it into a real mff-core checkout (see the end).

## Structure

```
module.manifest.json    # id, label, version, tablePrefix, mountPath, requires: ["slurm"]
backend/                 # Express router, own DB tables (db/schema.sql), planners and score parsers
frontend/                 # React components
docs/                       # link to the shared MFF-docs repo - never edited here
```

## What it runs

The module builds for AlphaPulldown 2.9 with AlphaFold 3 as installed from `alphafold3_alphapulldown` (micromamba), run directly under Slurm - no container and no Snakemake. Every path and resource is a Setup value (defaults match the Newcastle cluster: databases in `/home/linuxhomes/software/genetic_db`, weights in `/home/linuxhomes/software/alphafold3/models`, partition `gpu`, `gpu:1`).

1. **Features (CPU)** - `create_individual_features.py --data_pipeline=alphafold3 --compress_features=True` once per distinct protein of the project, producing `<name>_af3_input.json.xz` in `P<n>/features/`. AlphaPulldown's AlphaFold 3 data pipeline does not support MMseqs2, so searches use the local databases. `pdb_seqres.txt` sits in a subfolder on this cluster, so it is passed explicitly (`--pdb_seqres_database_path`). A run is **one Slurm job**: its script searches `Proteins searched at once` proteins in parallel with `xargs -P` inside one allocation (a job array would need the Slurm module to confirm array handling, `requests/S1-slurm-array-jobs.md`). A protein whose feature file exists is skipped unless "search again" is ticked; failures are reported by name with their log. `timings.tsv` records index, length, seconds and exit code - no names - and feeds the speed database once.
2. **Prediction (GPU)** - the tab plans a run first: how many complexes, how many are already predicted or held back for size (over `warn_max_complex_aa`), an estimate from similar speed samples, the resources and a preview of the script. It refuses to start while features are missing. Each complex becomes **one Slurm job** running `run_multimer_jobs.py --mode=custom --protein_lists=fold_input.txt --fold_backend=alphafold3 --num_seeds --num_diffusion_samples --num_cycle` (one `A+B` line per job, so AlphaPulldown's own pairing logic is not needed and Slurm schedules complexes independently). The modes are bait vs candidates (`pulldown`), all vs all (every pair, **including each protein with itself**), and homo-oligomer (`name:copies`). Options: seeds, diffusion samples (default 5), recycles (default 10), a limit, and a bait filter. A run holds at most 5,000 complexes.
3. **Results** - for each finished complex the module reads AlphaFold 3's `<fold>_summary_confidences.json` and stores ipTM, pTM, ranking score, the best (lowest) off-diagonal `chain_pair_pae_min` and the clash flag. The tab sorts and filters them, downloads the best model (`.cif`) and summary, and exports a CSV. For deeper browsing the output folder is a normal AlphaPulldown output directory, readable by APLit and AlphaJudge (the tab says so).

Layout in the user's workspace: `module-AlphaPulldown/P<n>/` holds `features/`, `msa/run-<id>/` (`submit.sh`, `run_one.sh`, `msa_input.fasta`, names, lengths, `timings.tsv`, `logs/`) and `predictions/run-<id>/job-<item>/` (`submit.sh`, `fold_input.txt`, `slurm.out`/`slurm.err`, `output/`). `predictions/jax-cache/` is shared by the project so a model shape compiles once.

**There is no background process.** A run advances only while its owner has the page open: each time the Prediction tab loads, it refreshes submitted jobs from the Slurm module (`GET /external/jobs/:id`), records the finished ones in the speed database (once each), reads scores of completed outputs, and submits queued complexes while fewer than `Prediction jobs in flight` (Setup) are running. Close the page and nothing more is submitted; jobs already submitted keep running on the cluster. A job that cannot be submitted is retried up to three times, then marked SUBMIT_FAILED. "Retry failed" requeues failed complexes (and clears their scores), "Cancel" drops queued ones and cancels submitted ones through the Slurm module, and deleting a run removes only its database record, never files.

The Setup tab also holds unified-memory settings (`XLA_PYTHON_CLIENT_PREALLOCATE=false`, `TF_FORCE_UNIFIED_MEMORY=true`, `XLA_CLIENT_MEM_FRACTION=3.2`) so a complex larger than GPU memory can spill to host RAM.

## Speed estimates

Every finished feature or prediction job adds one anonymised row to `alphapulldown_speed_samples`: sizes in amino acids, a method label, a hardware label, run and queue seconds, an outcome and the day. No user, project, job, protein name, accession or sequence is stored, and there is no route that lets a client write to the table - only the module's own backend does, from jobs it observed. The stats strip turns those samples into a typical and a slow-case wall time and CPU/GPU-hours, with a confidence level:

- fewer than 5 finished samples: no estimate, just how many have been recorded
- 5 to 29: low confidence; 30 or more: good
- confidence also drops to low when the estimate borrows samples from other hardware, or when many jobs are larger than anything measured (the figures are then shown as a minimum)
- similar-sized jobs that failed or ran out of memory are reported as a warning
- the feature estimate uses the caller's Setup values; the prediction estimate uses the options of the project's latest prediction run, or pools every fold sample until the project has one (the strip says so). The Prediction tab's plan estimates for the options being chosen.

## Speed statistics (staff)

Staff (the same roles as Page Access) get a **Speed statistics** tab that shows what the speed database holds: samples recorded in total and per stage (finished or not), samples per day for the last 30 days, and one row per class - a method on one kind of hardware, which is exactly what an estimate learns from. Each class shows its sample count, how many finished and how many did not (out of memory, timed out, failed), a confidence level (none under 5 finished samples, low under 30, good from 30 - the same thresholds as the stats strip), the typical and slow (90th percentile) run time, the median queue wait, and the sizes covered. A row opens into timings by size band. Labels read in words ("2 seeds, 5 samples, 10 recycles"; "1 GPU on gpu") with the raw label on hover.

It is read-only: `GET /alphapulldown/speed/summary` is the only route, there is none that adds, edits or deletes a sample, and the response carries no names because the table holds none. Classes are built from the newest 20,000 samples per stage (the ones the estimator reads); when the table is bigger the tab says so. The tab is not a page-access key: it is for staff only.

## Speed statistics (staff)

Staff (the same roles as Page Access) get a **Speed statistics** tab that shows what the speed database holds: samples recorded in total and per stage (finished or not), samples per day for the last 30 days, and one row per class - a method on one kind of hardware, which is exactly what an estimate learns from. Each class shows its sample count, how many finished and how many did not (out of memory, timed out, failed), a confidence level (none under 5 finished samples, low under 30, good from 30 - the same thresholds as the stats strip), the typical and slow (90th percentile) run time, the median queue wait, and the sizes covered. A row opens into timings by size band. Labels read in words ("2 seeds, 5 samples, 10 recycles"; "gpu partition, 1 GPU") with the raw label on hover.

It is read-only: `GET /alphapulldown/speed/summary` is the only route, there is none that adds, edits or deletes a sample, and the response carries no names because the table holds none. Classes are built from the newest 20,000 samples per stage (the ones the estimator reads); when the table is bigger the tab says so. The tab is not a page-access key: it is for staff only.

## Installing into a real mff-core checkout

Clone this repo to `App_frontend/src/core/alphapulldown/` inside a real mff-core checkout (or use Install on Preferences → Modules). This module's id, `alphapulldown`, must match that folder name.

Install provisions this module's own database and user, generates a random password, and writes `MODULE_ALPHAPULLDOWN_DB_HOST`/`_USER`/`_PASSWORD`/`_NAME` into `App_backend/.env` itself - nothing for an admin to type. Full mechanism: `docs/MFF-Core_module-database-provisioning.md`. The Slurm module (`requires: ["slurm"]` in the manifest) must be installed first, and a dedicated `GRANT ... ON mff_module_alphapulldown.*` line may be needed once per deployment - see that same doc's provisioning section.

Restart core's backend afterwards so it picks up the new `.env` values.

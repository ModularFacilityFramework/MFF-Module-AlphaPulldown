# AlphaPulldown

An [MFF-core](../mff-core) feature module for running AlphaPulldown jobs on a Slurm cluster. Users define their inputs in the UI; this module generates the job's input files and sbatch script, writes them into the user's core workspace, and submits the job to the Slurm module.

> **Status: in development.** The module is built in phases: (0) project shell, settings and statistics, done; (1) Sequences tab (UniProt search, FASTA, proteome download and browsing, selection, AlphaPulldown files), done; (2) anonymised speed database and estimates in the stats strip, done (estimates read "no estimate yet" until the Features and Co-folding tabs have recorded finished jobs); (3) Features (CPU) tab, done; (4) Co-folding (GPU) tab through the ABCFold module, done (it assumes the ABCFold module's API, which is not documented yet - see the Co-folding section); (5) staff Speed statistics tab and polish, done.

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

## Shared library

Every UniProt proteome used here lives **once**, in one folder shared by all MFF-core users (`library_dir`, set by staff in Setup, e.g. `/home/linuxhomes/software/alphapulldown_library/`), not once per user. The **Library** tab lists them and what each one is; anyone can add a proteome (a release the library already holds is not downloaded again), staff can remove one that no project uses.

```
<library_dir>/
  README.txt
  proteomes/<UPID>/<UniProt release>/<all|reviewed>/proteome.fasta, metadata.json
  features/<UPID>_<release>_<subset>_<tag>_<config hash>/set.json, <name>_af3_input.json.xz, .locks/
```

- **A proteome version is immutable.** UniProt release `2026_04` and `2026_05` of the same proteome are two folders; nothing is overwritten. `metadata.json` (and the matching row in `alphapulldown_library_proteomes`) records: organism, taxon, UniProt proteome id and type, genome assembly, BUSCO completeness, **UniProt release and its date** (from the `X-UniProt-Release` headers of the download), content (all or reviewed), entry count, file size and **SHA-256**, the source (`rest.uniprot.org`), the download date and the module version.
- **A feature set** holds the input features of ONE proteome version built under ONE configuration: format (AlphaPulldown's AlphaFold 3 input JSON), template cut-off date, genetic database folder and the staff **feature set tag**. A different configuration is a different folder, so features built two ways never mix. `set.json` records that configuration and, written by the first job that builds into the set, the **software and database versions**: AlphaPulldown, AlphaFold 3 and JAX versions, and the name, size and date of every database file the pipeline reads (UniRef90, MGnify, UniProt, BFD, PDB mmCIF, pdb_seqres). Every later job checks that its own environment has the same fingerprint before adding anything and stops (exit 3, with the differences in `slurm.err`) if the databases or software changed: staff then change the tag in Setup so a new set starts.
- A project that picks proteins from a library proteome keeps `proteome_id` and the accession with each protein, so it is tied to that exact version.

## Features stage

The Features (CPU) tab runs AlphaPulldown's `create_individual_features.py --data_pipeline=alphafold3 --compress_features=True` for the project's distinct proteins against the cluster's genetic databases (the installed AlphaPulldown 2.9 with AlphaFold 3's data pipeline, which has no MMseqs2 mode; `pdb_seqres` sits in a subfolder and is passed explicitly). A run is **one Slurm job**: its script searches `Proteins searched at once` proteins in parallel with `xargs -P` inside a single allocation (a job array would need the Slurm module to confirm array handling, `requests/S1-slurm-array-jobs.md`).

- **Proteins from a library proteome** are built into that proteome version's feature set - once for everybody, under a per-protein lock so two users asking for the same protein compute it once - and **symlinked** into the project's `features/` folder (no copy). A protein already in the set is only linked. "Search again" never rebuilds a shared feature.
- **The user's own pasted sequences** are built in the project's own `features/` folder as before.
- Before searching, the job runs `capture_env.py`, which records the software and databases it really runs with in `environment.json` and checks the feature sets as described above.
- Each run has its own folder, `module-AlphaPulldown/P<n>/msa/run-<id>/`: `submit.sh`, `run_one.sh`, `capture_env.py`, `msa_input.fasta`, `msa_names.txt`, `msa_lengths.txt`, `msa_targets.txt`, `sets.txt`, `timings.tsv`, `environment.json`, `provenance.json` and one log per protein in `logs/`. `timings.tsv` records index, length, seconds, exit code and status - no names - and is copied into the anonymised speed database the first time the run is seen finished.
- The features are AlphaPulldown/AlphaFold 3 input JSON files (one protein chain each, MSA and templates filled). **The ABCFold module does not accept them yet**: it builds its own input from sequences only (confirmed with its session). The preferred hand-off, a per-chain `featuresPath` on `POST /jobs` merged into the generated input, has been put to that session; until it exists the prediction stage sends sequences only.

## Provenance

Every run records exactly what it used, so a methods section can be written from it:

- `alphapulldown_msa_runs.provenance_json` and `provenance.json` in the run folder: the module version, the settings (environment, database folder, pdb_seqres, template cut-off), one entry per proteome version used (UPID, organism, taxon, UniProt release and date, content, entry count, SHA-256) with its feature set (id, key, tag, format, template cut-off), the number of proteins that were the user's own, and - added when the job ends - the software versions and database files the job itself recorded.
- `alphapulldown_cofold_runs.provenance_json`: the same proteome/feature-set facts for the proteins a prediction run folds (read from where the project's feature links point, so it is what is on disk), plus the options chosen.
- `GET /alphapulldown/projects/:id/provenance` and the **Methods** panel under the Features and Co-folding tabs write a paragraph from the project's latest finished feature run and latest prediction run, with the AlphaPulldown2 citation (Molodenskiy et al. 2025, Bioinformatics, doi:10.1093/bioinformatics/btaf115). A fact that was not recorded is listed as missing, never filled in.

## Co-folding stage

The Co-folding (GPU) tab folds every bait-candidate pair (or, for the other modes, every pair of two proteins, or each protein alone for a homo-oligomer) with **one ABCFold job per pair**, created through the ABCFold module with `coreApi.callModule(token, 'abcfold', ...)` and the calling user's own token. The tab plans a run first: how many pairs, how many are already folded or held back for size (over `warn_max_complex_aa`), an estimate from the speed samples filed under the same options, and the first few pairs. A run holds at most 5,000 pairs; narrow a bigger selection by bait or with a limit. Options: model seeds, GPUs per pair, MSA search (leave to the ABCFold module, MMseqs2 server, or local database), templates, and handing over the MSAs from the MSA tab.

**There is no background process.** A run advances only while its owner has the page open: each time the tab loads the run list, it refreshes the submitted pairs from ABCFold, ingests the finished ones into the speed database (once each), and submits queued pairs while fewer than `Co-folding jobs in flight` (Setup) are running. Close the page and nothing more is submitted until it is opened again; jobs already submitted keep running on the cluster. The tab says so. A pair that cannot be submitted is retried up to three times, then marked SUBMIT_FAILED (one failure stops that round, so a missing ABCFold module is one message, not hundreds). "Retry failed" puts failed pairs back in the queue; "Cancel" drops the queued ones and cancels the submitted ones in Slurm (through the Slurm module, using the Slurm job id ABCFold answered with).

**The ABCFold API is assumed, not documented** (`requests/A2-abcfold-documented-external-surface.md`). `backend/services/abcfoldClient.js` is the only place that knows it: `POST /jobs` with name, `sequences` (`{type, id, sequence}`, one chain per copy), `modelSeeds`, `models: ['alphafold3']`, `templates`, `gpuCount` and optionally `mmseqs2`, answering `{id, status, slurm_job_id}`; `GET /jobs/:id/status` answering `state`, `submittedAt`, `startedAt`, `endedAt`. If the real module differs, change that file.

**MSA reuse is not available yet.** The ABCFold module accepts no precomputed MSA or features (`requests/A1-abcfold-per-chain-msa.md` is still open). The Features stage no longer writes `<name>.a3m` files (the AlphaFold 3 pipeline leaves `<name>_af3_input.json.xz` instead), so the "hand over the MSAs" box finds nothing to hand over and the prediction stage searches for its own MSAs.

Each pair's end state becomes one speed sample (stage `fold`, both lengths, method label such as `s2-mmseqs2`, hardware `gpu<N>`, run and queue seconds from the Slurm timestamps ABCFold reports, outcome ok/oom/timeout/failed). Cancelled and never-submitted pairs give no sample.

## Speed estimates

Every finished MSA or co-folding job adds one anonymised row to `alphapulldown_speed_samples`: sizes in amino acids, a method label, a hardware label, run and queue seconds, an outcome and the day. No user, project, job, protein name, accession or sequence is stored, and there is no route that lets a client write to the table - only the module's own backend does, from jobs it observed. The stats strip turns those samples into a typical and a slow-case wall time and CPU/GPU-hours, with a confidence level:

- fewer than 5 finished samples: no estimate, just how many have been recorded
- 5 to 29: low confidence; 30 or more: good
- confidence also drops to low when the estimate borrows samples from other hardware, or when many jobs are larger than anything measured (the figures are then shown as a minimum)
- similar-sized jobs that failed or ran out of memory are reported as a warning
- the MSA estimate uses the caller's Setup values; the co-folding estimate uses the options of the project's latest co-folding run, or pools every fold sample until the project has one (the strip says so). The Co-folding tab's plan estimates for the options being chosen.

## Speed statistics (staff)

Staff (the same roles as Page Access) get a **Speed statistics** tab that shows what the speed database holds: samples recorded in total and per stage (finished or not), samples per day for the last 30 days, and one row per class - a method on one kind of hardware, which is exactly what an estimate learns from. Each class shows its sample count, how many finished and how many did not (out of memory, timed out, failed), a confidence level (none under 5 finished samples, low under 30, good from 30 - the same thresholds as the stats strip), the typical and slow (90th percentile) run time, the median queue wait, and the sizes covered. A row opens into timings by size band. Labels read in words ("3 seeds, MMseqs2 server, templates"; "2 GPUs") with the raw label on hover.

It is read-only: `GET /alphapulldown/speed/summary` is the only route, there is none that adds, edits or deletes a sample, and the response carries no names because the table holds none. Classes are built from the newest 20,000 samples per stage (the ones the estimator reads); when the table is bigger the tab says so. The tab is not a page-access key: it is for staff only.

## Installing into a real mff-core checkout

Clone this repo to `App_frontend/src/core/alphapulldown/` inside a real mff-core checkout (or use Install on Preferences → Modules). This module's id, `alphapulldown`, must match that folder name.

Install provisions this module's own database and user, generates a random password, and writes `MODULE_ALPHAPULLDOWN_DB_HOST`/`_USER`/`_PASSWORD`/`_NAME` into `App_backend/.env` itself - nothing for an admin to type. Full mechanism: `docs/MFF-Core_module-database-provisioning.md`. The Slurm and ABCFold modules (`requires: ["slurm", "abcfold"]` in the manifest) must be installed first, and a dedicated `GRANT ... ON mff_module_alphapulldown.*` line may be needed once per deployment - see that same doc's provisioning section.

Restart core's backend afterwards so it picks up the new `.env` values.

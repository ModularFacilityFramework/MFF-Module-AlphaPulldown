# Request S1 - Slurm module: array jobs through the external API

**From:** the AlphaPulldown module (`MFF-Module-AlphaPulldown`).
**To:** a session working in the **Slurm module repo** (`MFF-Module-SLURM`).
**Priority:** needed for the AlphaPulldown MSA stage (there is a fallback, see below).

**Current state:** the AlphaPulldown MSA tab ships with the fallback described at the end (one job, proteins in parallel inside it). It works against the documented API as it stands; an answer here would let it switch to an array for per-protein scheduling.

## Why

AlphaPulldown's feature (MSA) stage is naturally a Slurm **job array**: one task per protein, `create_individual_features.py --seq_index=$SLURM_ARRAY_TASK_ID`. The AlphaPulldown module would write a `submit.sh` containing `#SBATCH --array=1-N%K` into a prepared `workDir` and submit it with `POST /external/jobs`, exactly as the docs describe.

## What we need to know, or have changed

1. Does `POST /external/jobs` accept a `submit.sh` that contains `#SBATCH --array=1-N%K` and pass it through to `sbatch --chdir <workDir>` unchanged? If something strips or conflicts with it (for example your own `--output` / `--error` flags, which would make all tasks write to the same `slurm.out`), say so.
2. What does `GET /external/jobs/:jobId` return for the **array parent job id**?
   - `sacct -j <id> --json` returns one entry per task. Which `state`, `startedAt`, `endedAt` do you report: first task, last task, or an aggregate?
3. Preferred outcome: for an array parent, add an aggregate to the response, for example
   ```json
   { "jobId": 123, "state": "RUNNING", "array": { "total": 40, "pending": 10, "running": 20, "completed": 9, "failed": 1 } }
   ```
   with `state` meaning "RUNNING while any task is active, COMPLETED only when all completed, FAILED if any failed once none are active". Existing non-array responses stay unchanged.
4. Output files: with an array, `slurm.out` / `slurm.err` for every task collide. State the recommended pattern (for example the caller uses `%A_%a` in its own `#SBATCH --output`, and your fixed `--output=slurm.out` is skipped for scripts that already declare their own). We only need to know what is supported.
5. Does `POST /external/jobs/:jobId/cancel` cancel the whole array?

## Fallback if this is not wanted

AlphaPulldown submits **one CPU job** whose script loops over the proteins in parallel (`xargs -P`). No Slurm module change needed, but no per-task scheduling and a longer single reservation. Please tell us if you prefer that; the document answering 1-5 is enough either way.

## Done when

- A 3-task array submitted through `POST /external/jobs` runs, its status can be fetched until it ends, and the response is documented in `docs/MFF-Module-SLURM_slurm-config.md`, including the points above.

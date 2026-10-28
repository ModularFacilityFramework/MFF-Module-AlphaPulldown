# Request A2 - ABCFold module: document a stable cross-module surface

**From:** the AlphaPulldown module (`MFF-Module-AlphaPulldown`).
**To:** a session working in the **ABCFold module repo** (`MFF-Module-ABCFold`).
**Priority:** needed, not blocking (we can start from the routes as they are today).

## Why

AlphaPulldown calls ABCFold only through `coreApi.callModule(token, 'abcfold', method, path, opts)`, always with the **calling user's own token**. Right now the only record of ABCFold's HTTP routes is its own source. The Slurm module documents a dedicated `/external/*` router in `docs/MFF-Module-SLURM_slurm-config.md`; we would like the same for ABCFold so that the contract is explicit and does not break silently when the UI-facing routes change.

## What is needed

Document (a short section in a shared doc, or a separate `/external/*` router like the Slurm module's, your choice) exactly these operations, each with method, path, request body, response body and error statuses:

1. **Create and submit a job.** Input: name, protein sequences (id + sequence), optional `unpairedMsaPath` per chain (request A1), model list, seeds, MMseqs2 / templates flags, GPU count. Output: the job's id and initial state.
2. **Get job status.** The response **must keep** `state`, `submittedAt`, `startedAt`, `endedAt` (Slurm's own vocabulary is fine). AlphaPulldown records run time and queue time from these and nothing else.
3. **List job files and download one file** (we link to each pair's report and logs).
4. **Delete / cancel**, if available (state what exists; do not add it just for us).

Also state: ownership rules (a caller only sees their own jobs), and the error shape (`{ error, message }`).

## Done when

- The operations above are documented in one place another module's developer can find.
- The fields listed in 2 are guaranteed by that document (changing them is a documented breaking change).

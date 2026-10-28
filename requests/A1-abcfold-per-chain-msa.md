# Request A1 - ABCFold module: accept a precomputed MSA per protein chain

**From:** the AlphaPulldown module (`MFF-Module-AlphaPulldown`), which `requires` the ABCFold module.
**To:** a session working in the **ABCFold module repo** (`MFF-Module-ABCFold`).
**Priority:** blocking for the AlphaPulldown module's co-folding stage.

## Why

AlphaPulldown pulls one bait against many candidates. Its MSA stage computes each protein's MSA once, as an A3M file in the user's workspace. The co-folding stage then creates one ABCFold job per bait-candidate pair through `coreApi.callModule(token, 'abcfold', 'POST', '/jobs', { body })`. Today ABCFold's job route only takes sequences, so ABCFold re-searches the bait's MSA for every pair. We want it to reuse the A3M we already have.

## What is needed

Let the job-creation route (`POST /jobs`) and the resubmit route (`POST /jobs/:id/submit`) accept, on each protein entry in `sequences`, an optional field:

```json
{ "type": "protein", "id": "A", "sequence": "MKT...", "unpairedMsaPath": "/abs/path/inside/the/user/workspace/P3/msa/P78344.a3m" }
```

1. **Path safety (hard requirement).** `unpairedMsaPath` must resolve inside the calling user's own workspace, i.e. under `coreApi.getUserWorkspacePath(req.user).path`.
   - Check after `path.resolve`, and refuse symlinks (use `fs.realpath` / `lstat`), so one user cannot point a job at another user's files.
   - Anything else returns `400` with a clear message. Never read a path outside the workspace.
2. **Use.** Read the file and put its text in the AF3 input JSON as that chain's `unpairedMsa`. For a chain that has one, ABCFold must not run its own MSA search for that chain. Chains without the field behave exactly as today.
3. **Size.** Pass paths, never file contents, in the request body. No large bodies should need to travel through `callModule`.
4. **Backwards compatible.** Requests without the field are unchanged.

## Verify before building (the upstream README does not document this)

ABCFold's README does not say how it treats MSAs that are already in the input JSON, or whether `--mmseqs2` / `--database` searches are skipped when they are. Before relying on it:
- Run the installed `abcfold --help` and read the relevant flags.
- Run one small job (two short chains) with `unpairedMsa` filled in and confirm in `slurm.out` / `slurm.err` that no MSA search happens for those chains and the job completes.
- If ABCFold always searches regardless, tell us before implementing the route change; the design here changes.

## Done when

- A job created with two chains that carry `unpairedMsaPath` runs to completion and its logs show no MSA search for those chains.
- A path outside the caller's workspace, a path through a symlink, and a path to a missing file each return a `4xx` with a clear message.
- Existing requests without the field behave as before.
- The new field is documented in the ABCFold module's own docs (see request A2).

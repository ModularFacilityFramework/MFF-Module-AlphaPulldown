# AlphaPulldown

An [MFF-core](../mff-core) feature module for running AlphaPulldown jobs on a Slurm cluster. Users define their inputs in the UI; this module generates the job's input files and sbatch script, writes them into the user's core workspace, and submits the job to the Slurm module.

> **Status: scaffold.** This module was bootstrapped from the ABCFold module and renamed (id, manifest, tables, routes, UI). The tool-specific parts - the `abcfold` CLI command builder, the AlphaFold3 input-JSON builder, the report viewer, and the `abcfold_command` column in `alphapulldown_jobs` - are still ABCFold's and have not been rewritten for AlphaPulldown yet.

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

## Installing into a real mff-core checkout

Clone this repo to `App_frontend/src/core/alphapulldown/` inside a real mff-core checkout (or use Install on Preferences → Modules). This module's id, `alphapulldown`, must match that folder name.

Install provisions this module's own database and user, generates a random password, and writes `MODULE_ALPHAPULLDOWN_DB_HOST`/`_USER`/`_PASSWORD`/`_NAME` into `App_backend/.env` itself - nothing for an admin to type. Full mechanism: `docs/MFF-Core_module-database-provisioning.md`. The Slurm and ABCFold modules (`requires: ["slurm", "abcfold"]` in the manifest) must be installed first, and a dedicated `GRANT ... ON mff_module_alphapulldown.*` line may be needed once per deployment - see that same doc's provisioning section.

Restart core's backend afterwards so it picks up the new `.env` values.

# ABCFold

An [MFF-core](../mff-core) feature module for running [ABCFold](https://github.com/rigdenlab/ABCFold) — a protein-structure-prediction tool wrapping AlphaFold3/Boltz/Chai-1/etc. — on a Slurm cluster. Users provide protein sequences and optional ligand SMILES; this module generates the AlphaFold3-format input JSON, the `abcfold` CLI invocation, and a Slurm sbatch script as a draft (actual submission isn't available yet — see "Known limitations" below).

## Quick start

```bash
nvm use
npm install
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

Full mechanism: `docs/MFF-Core_module-database-provisioning.md`. Two cases:

**A genuinely fresh Install (this module has never been installed on this deployment before)** needs no manual step at all. Clicking Install on Preferences → Modules provisions this module's own database and user, generates a random password, and writes `MODULE_ABCFOLD_DB_HOST`/`_USER`/`_PASSWORD`/`_NAME` into `App_backend/.env` itself — there is nothing for an admin to generate or type. This is already fully automatic, per `docs/MFF-Core_module-database-provisioning.md`'s "What Install and Update actually do".

**Migrating an already-installed deployment from before `coreApi.getModuleConfig()`** (true for every real deployment of this module as of this writing) needs one manual, one-time step before the next Update — this is *not* automatic, and must be done by an admin with shell access:

1. Find this module's four existing values in its old module-local `.env` (`App_frontend/src/core/abcfold/.env`): `MODULE_DB_HOST`, `MODULE_DB_USER`, `MODULE_DB_PASSWORD`, `MODULE_DB_NAME`.
2. Copy them into core's own `App_backend/.env`, renamed with this module's own prefix: `MODULE_ABCFOLD_DB_HOST`, `MODULE_ABCFOLD_DB_USER`, `MODULE_ABCFOLD_DB_PASSWORD`, `MODULE_ABCFOLD_DB_NAME`.
3. Delete the old `App_frontend/src/core/abcfold/.env` file.
4. Restart core's own backend, then run Update (or Apply Schema) for this module.

Skipping this leaves the module unable to reach its own database after the next Update — `readModuleDbCredentials()` finds nothing under the new prefix and refuses rather than guessing (see `docs/MFF-Core_module-database-provisioning.md`'s "Migrating an already-installed module" section for the full reasoning).

## Known limitations

This module (ABCFold) can generate job drafts (sbatch script + input JSON) but cannot submit them yet — coreApi has no job-submission hand-off to a Slurm module yet (no `coreApi.slurm.*`, no shared job-queue table). (Its dependency on the Slurm module being installed is itself already enforced via `module.manifest.json`'s `requires` field — see `docs/MFF-Core_module-manifest.md`.)

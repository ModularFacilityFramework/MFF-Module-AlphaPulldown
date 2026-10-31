# CLAUDE.md — this module

This repo was cloned from MFF-Module-template to build a single MFF-core feature module. Read `docs/MFF-Core_module-core-api.md` before writing any code here.

## General rules (same for every MFF session)

- **This repo is the only thing you may read, edit, commit, or push.** Never clone, open, edit, commit, or push to any other repo in this workspace — not `mff-core`, not another `MFF-Module-*` — even if its checkout happens to be present on disk alongside this one. (`docs/` itself is a deliberate exception: it's a symlink to `../mff-core/docs`, a shared documentation space core and every module link to — reading it is expected and fine.)
- **Need something from another repo? Send a message, don't touch its files.** Use cross-session messaging (SendMessage / ListAgents) to the owning session instead of touching its files yourself. No agent teams — collaboration between modules happens only through these direct cross-session messages.
- **Always commit and push automatically.** As soon as a change in this repo is in a working state, stage it, commit it, and push it to `origin` right away — don't wait for a separate "commit this" / "push this" request.
- Everything this module needs from `mff-core` goes through the documented `coreApi` contract (`docs/MFF-Core_module-core-api.md`). If something you need isn't there, send a message to the relevant agent/session to request that information or to request a new function be implemented in that core dependency — never a reason to import or reach into another repo's own code yourself.
- Modules never import other modules directly — cross-module communication goes through `coreApi`/core, or a cross-session message to that module's own session.
- Always read the relevant file before editing it.
- Ask if unsure — do not assume.
- **No `.env` files for the frontend, ever.** There is exactly one `.env` for the entire backend (`App_backend/.env`), owned and written by `mff-core` — including every module's own generated credentials. A module never creates, reads, or maintains an `.env` of its own; all backend config comes through `coreApi.getModuleConfig()`.

## Shared module conventions (same for every module repo)

- **Never add an import/require that escapes this repo's own root.** `.eslintrc.json` blocks `**/mff-core/**` outright — if that rule ever needs bypassing, that's a sign something belongs in `coreApi` instead, not a reason to disable the rule.
- **Table names must carry `module.manifest.json`'s `tablePrefix`, no exceptions.** Checked nowhere automatically today — hold yourself to it.
- **No local dev harness, and none gets added back.** This repo has no `dev/` folder and no `npm run dev` - real testing happens against a real mff-core checkout only.
- **This repo has no install script, on purpose.** Installing means `git clone`-ing this repo directly to `App_frontend/src/core/<id>/` inside a real mff-core checkout (see `docs/MFF-Core_module-database-provisioning.md`) — a real checkout, never a copy or symlink of one. That's mff-core's own decision to make, not something this repo orchestrates.
- **`module.manifest.json`'s `version` field is auto-bumped by a tracked pre-commit hook (`.githooks/pre-commit`) — never hand-edit it.** One-time setup per fresh clone (git never auto-enables a tracked `hooksPath`): `chmod +x .githooks/pre-commit && git config core.hooksPath .githooks`.
- No migrations, ever — `backend/db/schema.sql` is this module's single source of truth, edited directly.

## Module-specific

- **This module:** `alphapulldown` (`module.manifest.json`), mounted at `/alphapulldown`, table prefix `alphapulldown_`.
- **Depends on:** `slurm`, `abcfold` — message those modules' sessions for anything needed from them (e.g. SLURM job submission, ABCFold's external surface).
- **Depended on by:** none currently.
- **Docs:** no module-owned doc file exists in `own-docs/` yet; when one is needed, create it there and message `mff-core`'s session to add the matching symlink in its `docs/`.
- `requests/` in this repo holds cross-repo feature requests addressed to SLURM, ABCFold, and mff-core — superseded by direct cross-session messaging now; treat new requests as messages, not new files in `requests/`.

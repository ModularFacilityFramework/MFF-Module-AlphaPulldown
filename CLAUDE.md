# CLAUDE.md — this module

This repo was cloned from MFF-Module-template to build a single MFF-core feature module. Read `docs/MFF-Core_module-core-api.md` before writing any code here.

## General rules (same for every MFF session)

- **This repo is the only thing you may read, edit, commit, or push.** Never clone, open, edit, commit, or push to any other repo in this workspace — not `mff-core`, not another `MFF-Module-*` — even if its checkout happens to be present on disk alongside this one. (`docs/` itself is a deliberate exception: it's a link to `../MFF-docs/docs`, the shared documentation repo every session links to — reading it is expected and fine.)
- **Need something from another repo? Send a message, don't touch its files.** Use cross-session messaging (SendMessage / ListAgents) to the owning session instead of touching its files yourself. No agent teams — collaboration between modules happens only through these direct cross-session messages.
- **All documentation lives in one place: the `MFF-docs` repo, owned by the `mff-docs` session.** `docs/` in this repo is only a link to `../MFF-docs/docs` — the single copy every session reads. Never edit, create, rename, or delete anything under it, and never `git add` it. To add or change a doc, message `mff-docs` with the exact change; it updates the file, commits, and pushes. Questions about what the docs say can go to `mff-docs` too.
- **Always commit and push automatically.** As soon as a change in this repo is in a working state, stage it, commit it, and push it to `origin` right away — don't wait for a separate "commit this" / "push this" request.
- Everything this module needs from `mff-core` goes through the documented `coreApi` contract (`docs/MFF-Core_module-core-api.md`). If something you need isn't there, send a message to the relevant agent/session to request that information or to request a new function be implemented in that core dependency — never a reason to import or reach into another repo's own code yourself.
- Modules never import other modules directly — cross-module communication goes through `coreApi`/core, or a cross-session message to that module's own session.
- Always read the relevant file before editing it.
- Ask if unsure — do not assume.
- **No `.env` files for the frontend, ever.** There is exactly one `.env` for the entire backend (`App_backend/.env`), owned and written by `mff-core` — including every module's own generated credentials. A module never creates, reads, or maintains an `.env` of its own; all backend config comes through `coreApi.getModuleConfig()`.

## Sessions in this workspace (same for every MFF session)

Each folder below has its own Claude session. Message the owning session by name (SendMessage); check ListAgents for the live name if a message does not go through.

| Folder (under `/home/linuxhomes/namlb/Documents/React/`) | Session | Role |
|---|---|---|
| `development/MFF-core` | `mff-core` | The hub: owns the `coreApi` contract, hosts and runs every module |
| `development/MFF-docs` | `mff-docs` | Owns all documentation — the only session that edits, commits, and pushes docs |
| `development/MFF-Module-ABCFold` | `mff-abcfold` | Module `abcfold` |
| `development/MFF-Module-AlphaPulldown` | `mff-alphapulldown` | Module `alphapulldown` |
| `development/MFF-Module-CryoEM` | `mff-cryoem` | Module `cryoem` |
| `development/MFF-Module-Desk` | `mff-desk` | Module `desk` |
| `development/MFF-Module-Doppio` | `mff-doppio` | Module `doppio` |
| `development/MFF-Module-Finance` | `mff-finance` | Module `finance` |
| `development/MFF-Module-Pandda2.inspect` | `mff-pandda2inspect` | Module `pandda2inspect` |
| `development/MFF-Module-SLURM` | `mff-slurm` | Module `slurm` |
| `development/MFF-Module-template` | `mff-template` | Scaffold cloned for each new module |
| `production/MFF-core` | `prod-mff-core` | Read-only debug session for that live deployment |
| `production/MFF-core-doppio` | `prod-mff-core-doppio` | Read-only debug session for that live deployment |
| `production/MFF-core-pandda2-inspect` | `prod-mff-core-pandda2-inspect` | Read-only debug session for that live deployment |
| `master` | `master` | Coordinates all sessions |

- Production sessions only read and report. Ask them what the live system shows (logs, service state, deployed version, data). Never ask them to change, restart, or deploy anything — the user deploys.
- Three Qt/C++ apps (sessions `guida-mx`, `crystaleye`, `cremp`, under `/home/linuxhomes/namlb/Documents/QT/`) will later be used by MFF. How is not decided — do nothing about it until the user asks.

## Shared module conventions (same for every module repo)

- **Never add an import/require that escapes this repo's own root.** `.eslintrc.json` blocks `**/mff-core/**` outright — if that rule ever needs bypassing, that's a sign something belongs in `coreApi` instead, not a reason to disable the rule.
- **Table names must carry `module.manifest.json`'s `tablePrefix`, no exceptions.** Checked nowhere automatically today — hold yourself to it.
- **No local dev harness, and none gets added back.** This repo has no `dev/` folder and no `npm run dev` - real testing happens against a real mff-core checkout only.
- **This repo has no install script, on purpose** (see `docs/MFF-Module-template_install.md` for why). Installing means `git clone`-ing this repo directly to `App_frontend/src/core/<id>/` inside a real mff-core checkout (see `docs/MFF-Core_module-database-provisioning.md` for how that actually works) — a real checkout, never a copy or symlink of one. That's mff-core's own decision to make, not something this repo orchestrates.
- **`module.manifest.json`'s `version` field is auto-bumped by a tracked pre-commit hook (`.githooks/pre-commit`) — never hand-edit it.** One-time setup per fresh clone (git never auto-enables a tracked `hooksPath`): `chmod +x .githooks/pre-commit && git config core.hooksPath .githooks`.
- No migrations, ever — `backend/db/schema.sql` is this module's single source of truth, edited directly.

## Module-specific

- **This module:** `alphapulldown` (`module.manifest.json`), mounted at `/alphapulldown`, table prefix `alphapulldown_`.
- **Depends on:** `slurm`, `abcfold` — message those modules' sessions for anything needed from them (e.g. SLURM job submission, ABCFold's external surface).
- **Depended on by:** none currently.
- **Docs:** no doc file for this module exists yet. When one is needed, message `mff-docs` to create `MFF-Module-AlphaPulldown_<topic>.md` in the shared docs repo.
- `requests/` in this repo holds cross-repo feature requests addressed to SLURM, ABCFold, and mff-core — superseded by direct cross-session messaging now; treat new requests as messages, not new files in `requests/`.

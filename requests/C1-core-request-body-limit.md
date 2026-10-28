# Request C1 - mff-core: request-body size limit for module routes

**From:** the AlphaPulldown module (`MFF-Module-AlphaPulldown`).
**To:** a session working in **mff-core**.
**Priority:** optional. If this is not easy, we chunk uploads in the browser and the request can be dropped.

## Why

The module's Sequences tab lets a user paste or upload a multi-protein FASTA (a proteome is about 12 MB; a typical pulldown set is far smaller). It posts that text to a module route as JSON or plain text. If core's body parser has a small default limit, a large paste fails with `413` before the module's router sees it.

## What we need

1. **Tell us** (docs, in `MFF-Core_module-manifest.md` or `MFF-Core_module-core-api.md`) the request-body limit currently applied to module routes, and by which mechanism.
2. **If it is small:** a supported way for a module to raise it **for its own routes only**, for example an optional manifest field such as `maxRequestBodyMB` that core applies when mounting that module's router. It must not change the limit for core's own routes. A module adding its own parser is only an option if core mounts module routers ahead of its global body parser.
3. A target of 32 MB would cover our needs.

## What we do not need

Nothing else from core. Workspace paths, `callModule`, `getModuleConfig` and the module database cover the rest. In particular, **no background scheduler is requested**: `callModule` requires the calling user's token, and giving modules a service identity would go against core's design.

## Done when

A POST of a 25 MB text body to a module route reaches the module's handler (no `413`), core's own routes keep their existing limit, and the mechanism is documented.

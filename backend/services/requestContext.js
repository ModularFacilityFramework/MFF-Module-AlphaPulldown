// Per-request facts every route needs, all from coreApi - never stored.
// account: req.user.username, documented in docs/MFF-Core_module-core-api.md
// as "the current user, for that request".
// email: req.user itself has no email field, but coreApi.listUsers()
// (system-wide list, {id, username, email, ...} per entry) does - find the
// entry matching req.user.id to get the current user's own email.
// workspace: coreApi.getUserWorkspacePath(req.user) - { active, path, reason }.
// active:false (not_configured on this deployment, or forbidden - this
// user's own workspace_storage_enabled checkbox in Users & Groups is off,
// or a filesystem error) means this module has nowhere to write files, so
// anything that needs the disk is refused with a 503.
async function getRequestContext(coreApi, req) {
  const account = req.user.username;
  const users = await coreApi.listUsers();
  const currentUser = users.find(u => u.id === req.user.id);
  const email = currentUser ? currentUser.email : undefined;
  const workspace = await coreApi.getUserWorkspacePath(req.user);

  return { account, email, workspace };
}

module.exports = { getRequestContext };

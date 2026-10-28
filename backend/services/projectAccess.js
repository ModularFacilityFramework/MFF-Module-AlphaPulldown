// The one place a project is looked up by id - always together with its
// owner, so no route can ever reach another user's project.
async function findProject(conn, id, ownerId) {
  const rows = await conn.query('SELECT * FROM alphapulldown_projects WHERE id = ? AND owner_id = ?', [id, ownerId]);
  return rows[0] || null;
}

module.exports = { findProject };

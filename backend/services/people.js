// People are shown as "First Last (username)" (core's UI rule); a user with no
// name on record is shown by username alone.
function personLabel(user) {
  if (!user) return '';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name ? `${name} (${user.username})` : user.username;
}

// A lookup from user id to that label. Core not answering leaves names empty.
async function nameLookup(coreApi) {
  let users = [];
  try {
    users = await coreApi.listUsers();
  } catch (err) {
    users = [];
  }
  const byId = new Map(users.map(u => [Number(u.id), u]));
  return id => personLabel(byId.get(Number(id)));
}

module.exports = { personLabel, nameLookup };

// An error that carries the HTTP status a route should answer with.
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { httpError };

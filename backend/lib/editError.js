// Error with an HTTP status, thrown by the edit/addition code and turned into a
// JSON response by the routes. Its own module so personEdits.js and
// additions.js can both use it without a circular require.
class EditError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = { EditError };

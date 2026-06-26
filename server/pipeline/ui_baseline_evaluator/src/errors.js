/**
 * Thrown when a component's baseline image does not exist.
 */
class BaselineMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineMissingError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BaselineMissingError);
    }
  }
}

module.exports = {
  BaselineMissingError
};

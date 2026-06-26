class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class RestrictedEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RestrictedEnvironmentError';
  }
}

module.exports = {
  ValidationError,
  RestrictedEnvironmentError
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError);
    }
  }
}

class RequiresHumanApproval extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequiresHumanApproval';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RequiresHumanApproval);
    }
  }
}

module.exports = {
  ValidationError,
  RequiresHumanApproval
};

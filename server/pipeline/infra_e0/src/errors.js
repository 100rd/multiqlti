class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ValidationError);
    }
  }
}

class MissingRollbackProofError extends ValidationError {
  constructor(message) {
    super(message);
    this.name = 'MissingRollbackProofError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MissingRollbackProofError);
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
  MissingRollbackProofError,
  RequiresHumanApproval
};


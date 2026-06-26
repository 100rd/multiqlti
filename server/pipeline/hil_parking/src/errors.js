class InvalidHILRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidHILRequestError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, InvalidHILRequestError);
    }
  }
}

class CircuitBreakerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitBreakerError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CircuitBreakerError);
    }
  }
}

module.exports = {
  InvalidHILRequestError,
  CircuitBreakerError
};

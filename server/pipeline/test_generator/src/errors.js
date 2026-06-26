class SpecGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecGenerationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

module.exports = {
  SpecGenerationError
};

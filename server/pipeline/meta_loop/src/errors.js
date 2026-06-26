class NoProgressError extends Error {
  constructor(message = 'No progress detected: consecutive identical errors thrown') {
    super(message);
    this.name = 'NoProgressError';
  }
}

class MaxRetriesExceededError extends Error {
  constructor(message = 'Maximum retries exceeded') {
    super(message);
    this.name = 'MaxRetriesExceededError';
  }
}

class BudgetExceededError extends Error {
  constructor(message = 'Budget limit exceeded') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

module.exports = {
  NoProgressError,
  MaxRetriesExceededError,
  BudgetExceededError,
};

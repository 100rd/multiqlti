export class EvaluatorTamperingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorTamperingError';
    Object.setPrototypeOf(this, EvaluatorTamperingError.prototype);
  }
}

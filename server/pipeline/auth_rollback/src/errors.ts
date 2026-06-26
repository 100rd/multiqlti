export class UnauthorizedExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedExecutionError';
    Object.setPrototypeOf(this, UnauthorizedExecutionError.prototype);
  }
}

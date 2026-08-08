export type WhylineExitCode = 2 | 3;

export class WhylineError extends Error {
  public readonly exitCode: WhylineExitCode;

  public constructor(message: string, exitCode: WhylineExitCode) {
    super(message);
    this.name = "WhylineError";
    this.exitCode = exitCode;
  }
}

export class InvalidInputError extends WhylineError {
  public constructor(message: string) {
    super(message, 2);
    this.name = "InvalidInputError";
  }
}

export class OperationalError extends WhylineError {
  public constructor(message: string) {
    super(message, 3);
    this.name = "OperationalError";
  }
}

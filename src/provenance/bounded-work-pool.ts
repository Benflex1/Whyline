import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";

export interface CorrelationWorkLimits {
  readonly scanWorkers: number;
  readonly gitProcessSlots: number;
  readonly projectionWorkers: number;
}

export interface BoundedWorkStats {
  readonly wallMs: number;
  readonly queueMsSum: number;
  readonly queueMsMax: number;
  readonly workMsSum: number;
}

function emptyWorkStats(): BoundedWorkStats {
  return { wallMs: 0, queueMsSum: 0, queueMsMax: 0, workMsSum: 0 };
}

export function defaultCorrelationWorkLimits(
  jobCount: number,
  parallelism = availableParallelism(),
): CorrelationWorkLimits {
  const jobs = Math.max(0, Math.trunc(jobCount));
  const hostParallelism = Math.max(1, Math.trunc(parallelism));
  return {
    scanWorkers: Math.min(jobs, hostParallelism),
    gitProcessSlots: Math.min(jobs, Math.max(1, Math.floor(hostParallelism / 2))),
    projectionWorkers: Math.min(jobs, hostParallelism),
  };
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("correlation worker limit must be a positive integer");
  }
  return value;
}

export class BoundedWorkPool {
  private readonly limit: number;
  private activeWorkers = 0;
  private runStats: BoundedWorkStats = emptyWorkStats();
  public maxObservedWorkers = 0;

  public constructor(limit: number) {
    this.limit = requireLimit(limit);
  }

  public async map<Input, Output>(
    inputs: readonly Input[],
    worker: (input: Input, ordinal: number) => Promise<Output>,
  ): Promise<Output[]> {
    const startedAt = performance.now();
    const enqueuedAt = inputs.map(() => startedAt);
    let queueMsSum = 0;
    let queueMsMax = 0;
    let workMsSum = 0;
    const results = new Array<Output>(inputs.length);
    let nextOrdinal = 0;
    const runWorker = async (): Promise<void> => {
      this.activeWorkers += 1;
      this.maxObservedWorkers = Math.max(this.maxObservedWorkers, this.activeWorkers);
      try {
        while (nextOrdinal < inputs.length) {
          const ordinal = nextOrdinal;
          nextOrdinal += 1;
          const input = inputs[ordinal];
          if (input === undefined) continue;
          const workStartedAt = performance.now();
          const queueMs = workStartedAt - (enqueuedAt[ordinal] ?? startedAt);
          queueMsSum += queueMs;
          queueMsMax = Math.max(queueMsMax, queueMs);
          try {
            results[ordinal] = await worker(input, ordinal);
          } finally {
            workMsSum += performance.now() - workStartedAt;
          }
        }
      } finally {
        this.activeWorkers -= 1;
      }
    };

    const workerCount = Math.min(this.limit, inputs.length);
    try {
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return results;
    } finally {
      this.runStats = {
        wallMs: performance.now() - startedAt,
        queueMsSum,
        queueMsMax,
        workMsSum,
      };
    }
  }

  public get stats(): BoundedWorkStats {
    return this.runStats;
  }
}

interface WaitingTask {
  readonly task: () => Promise<unknown>;
  readonly enqueuedAt: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

export class GitWorkGate {
  private readonly limit: number;
  private activeWorkers = 0;
  private readonly waiting: WaitingTask[] = [];
  private firstEnqueuedAt: number | null = null;
  private lastFinishedAt: number | null = null;
  private queueMsSum = 0;
  private queueMsMax = 0;
  private processMsSum = 0;
  public maxObservedWorkers = 0;

  public constructor(limit: number) {
    this.limit = requireLimit(limit);
  }

  public run<Output>(task: () => Promise<Output>): Promise<Output> {
    return new Promise<Output>((resolve, reject) => {
      const enqueuedAt = performance.now();
      this.firstEnqueuedAt ??= enqueuedAt;
      this.waiting.push({
        task: async () => task(),
        enqueuedAt,
        resolve: (value) => resolve(value as Output),
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.activeWorkers < this.limit && this.waiting.length > 0) {
      const waiting = this.waiting.shift();
      if (waiting === undefined) return;
      this.activeWorkers += 1;
      this.maxObservedWorkers = Math.max(this.maxObservedWorkers, this.activeWorkers);
      const startedAt = performance.now();
      const queueMs = startedAt - waiting.enqueuedAt;
      this.queueMsSum += queueMs;
      this.queueMsMax = Math.max(this.queueMsMax, queueMs);
      void waiting.task().then(
        (value) => waiting.resolve(value),
        (error: unknown) => waiting.reject(error),
      ).finally(() => {
        this.processMsSum += performance.now() - startedAt;
        this.lastFinishedAt = performance.now();
        this.activeWorkers -= 1;
        this.drain();
      });
    }
  }

  public get stats(): BoundedWorkStats & { readonly processMsSum: number } {
    return {
      wallMs: this.firstEnqueuedAt === null || this.lastFinishedAt === null
        ? 0
        : this.lastFinishedAt - this.firstEnqueuedAt,
      queueMsSum: this.queueMsSum,
      queueMsMax: this.queueMsMax,
      workMsSum: this.processMsSum,
      processMsSum: this.processMsSum,
    };
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedWorkPool,
  GitWorkGate,
  type CorrelationWorkLimits,
  defaultCorrelationWorkLimits,
} from "../src/provenance/bounded-work-pool.js";
import { InvocationGitRunner } from "../src/provenance/correlate-codex.js";

test("bounded pool preserves ordinal output under adversarial completion order", async () => {
  const pool = new BoundedWorkPool(2);
  const values = await pool.map([0, 1, 2, 3], async (value) => {
    await new Promise((resolve) => setTimeout(resolve, (3 - value) * 2));
    return value * 10;
  });

  assert.deepEqual(values, [0, 10, 20, 30]);
  assert.ok(pool.maxObservedWorkers <= 2);
});

test("Git gate never exceeds its injected process limit", async () => {
  const gate = new GitWorkGate(1);
  const values = await Promise.all([1, 2, 3].map((value) => gate.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return value;
  })));

  assert.deepEqual(values, [1, 2, 3]);
  assert.equal(gate.maxObservedWorkers, 1);
});

test("default limits are separately bounded by available parallelism and job counts", () => {
  const limits: CorrelationWorkLimits = defaultCorrelationWorkLimits(8, 4);
  assert.deepEqual(limits, {
    scanWorkers: 4,
    gitProcessSlots: 2,
    projectionWorkers: 4,
  });
});

test("invocation Git memoization coalesces identical concurrent lookups", async () => {
  let calls = 0;
  const delegate = {
    run: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {
        stdout: Buffer.from("value\n"),
        stderr: Buffer.from(""),
        exitCode: 0,
        signal: null,
      };
    },
  };
  const runner = new InvocationGitRunner(delegate, new GitWorkGate(1));
  const options = { cwd: "/fixture/repository" };
  const results = await Promise.all([
    runner.run(["rev-parse", "HEAD"], options),
    runner.run(["rev-parse", "HEAD"], options),
    runner.run(["rev-parse", "HEAD"], options),
  ]);

  assert.equal(calls, 1);
  assert.equal(runner.calls, 1);
  assert.equal(results.every((value) => value.exitCode === 0), true);
});

test("invalid scheduler limits fail at the process boundary", () => {
  assert.throws(() => new BoundedWorkPool(0), /positive integer/);
  assert.throws(() => new GitWorkGate(0), /positive integer/);
});

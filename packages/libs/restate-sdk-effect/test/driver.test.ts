/*
 * Copyright (c) 2023-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

// Driver semantics, with no Restate in sight (DESIGN §3, TODO S4-1/S4-3/S4-4).

import { describe, expect, it } from "vitest";
import { Context, Effect, Exit, Fiber, Queue, Semaphore } from "effect";
import { Driver, UnjournaledAsyncError } from "../src/internal.js";
import { FakeCancelled, FakeJournal, FakeSuspended } from "./harness.js";

/** Park on a journal entry named `name`, completing with its own name. */
const step = (driver: Driver, journal: FakeJournal, name: string) =>
  driver.park(name, () => journal.entry<string>(name));

const runProgram = <A, E>(
  driver: Driver,
  effect: Effect.Effect<A, E, never>
): Promise<Exit.Exit<A, E>> => driver.run(effect, Context.empty());

describe("driver — sequential handlers", () => {
  it("delivers one journal entry per tick and never journals a combinator", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const log: string[] = [];

    const program = Effect.gen(function* () {
      log.push(yield* step(driver, journal, "a"));
      log.push(yield* step(driver, journal, "b"));
      log.push(yield* step(driver, journal, "c"));
      return log.join(",");
    });

    const running = runProgram(driver, program);
    // The journal completes each entry as it shows up.
    await settleAll(journal, ["a", "b", "c"]);
    const exit = await running;

    expect(Exit.isSuccess(exit) && exit.value).toBe("a,b,c");
    expect(journal.created).toEqual(["a", "b", "c"]);
    // Sequential code costs no combinator entries: every tick had one source.
    expect(journal.raceWinners).toEqual([]);
  });

  it("reports a stuck handler instead of hanging", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const program = Effect.gen(function* () {
      const queue = yield* Queue.make<number>();
      // Nothing will ever offer: no durable operation is pending either.
      return yield* Queue.take(queue);
    });
    await expect(runProgram(driver, program)).rejects.toThrow(
      /handler is stuck/
    );
  });
});

describe("driver — concurrency", () => {
  it("races pending sources and delivers the journaled winner", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);

    const program = Effect.all(
      [step(driver, journal, "left"), step(driver, journal, "right")],
      { concurrency: "unbounded" }
    );

    const running = runProgram(driver, program);
    await tick();
    expect(journal.created).toEqual(["left", "right"]);
    // Complete out of creation order: the result still lands in slot order.
    journal.complete("right", "right");
    await tick();
    journal.complete("left", "left");
    const exit = await running;

    expect(Exit.isSuccess(exit) && exit.value).toEqual(["left", "right"]);
    // One combinator entry for the two-source tick; once "right" is delivered
    // only "left" is pending, so that tick awaits it directly (DESIGN §3.5).
    expect(journal.raceWinners).toEqual(["right"]);
  });

  it("interrupts the losing branch of a race and deregisters its source", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const events: string[] = [];

    const program = Effect.race(
      step(driver, journal, "slow").pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => events.push("slow torn down"))
        )
      ),
      step(driver, journal, "fast")
    );

    const running = runProgram(driver, program);
    await tick();
    journal.complete("fast", "fast");
    const exit = await running;

    expect(Exit.isSuccess(exit) && exit.value).toBe("fast");
    expect(events).toEqual(["slow torn down"]);
    // The loser's source is gone, so later ticks would not re-race it.
    expect(driver.pendingSources).toBe(0);
  });

  it("keeps in-memory coordination working across fibers", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);

    const program = Effect.gen(function* () {
      const queue = yield* Queue.make<string>();
      const semaphore = Semaphore.makeUnsafe(1);
      yield* Effect.forkChild(
        Effect.gen(function* () {
          const value = yield* step(driver, journal, "produced");
          yield* Queue.offer(queue, value);
        })
      );
      const taken = yield* semaphore.withPermits(1)(Queue.take(queue));
      return taken;
    });

    const running = runProgram(driver, program);
    await settleAll(journal, ["produced"]);
    const exit = await running;
    expect(Exit.isSuccess(exit) && exit.value).toBe("produced");
  });
});

describe("driver — failure channels", () => {
  it("delivers a source failure to its own fiber", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const boom = new Error("boom");

    const program = Effect.exit(step(driver, journal, "a"));
    const running = runProgram(driver, program);
    await tick();
    journal.fail("a", boom);
    const exit = await running;

    expect(Exit.isSuccess(exit)).toBe(true);
    const inner = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(inner !== undefined && Exit.isFailure(inner)).toBe(true);
  });

  it("turns invocation cancellation into a root interrupt, running finalizers", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const events: string[] = [];

    const program = Effect.gen(function* () {
      yield* Effect.forkChild(
        step(driver, journal, "child").pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => events.push("child cleanup"))
          )
        )
      );
      return yield* step(driver, journal, "main");
    }).pipe(Effect.ensuring(Effect.sync(() => events.push("handler cleanup"))));

    const running = runProgram(driver, program);
    await tick();
    // Cancellation is delivered as a rejection of the aggregate race.
    journal.fail("main", new FakeCancelled());
    journal.fail("child", new FakeCancelled());
    const exit = await running;

    expect(Exit.isFailure(exit)).toBe(true);
    expect(events).toContain("child cleanup");
    expect(events).toContain("handler cleanup");
    expect(driver.abortSignal.aborted).toBe(false); // replaced, not sticky
  });

  it("rethrows suspension verbatim and runs no finalizers", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const events: string[] = [];

    const program = step(driver, journal, "a").pipe(
      Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted"))),
      Effect.ensuring(Effect.sync(() => events.push("finalized")))
    );

    const running = runProgram(driver, program);
    await tick();
    journal.fail("a", new FakeSuspended());

    await expect(running).rejects.toBeInstanceOf(FakeSuspended);
    expect(events).toEqual([]);
  });
});

describe("driver — unjournaled async detector", () => {
  it("fails loudly when a foreign wake creates a journal entry", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);

    const program = Effect.gen(function* () {
      // A raw async park: nothing in the journal will resume this fiber.
      yield* Effect.callback<void>((resume) => {
        setTimeout(() => resume(Effect.void), 1);
      });
      // ...and then it touches the journal, which is the detectable sin.
      return yield* step(driver, journal, "after-foreign-wake");
    });

    // A second fiber keeps the driver parked on a real source meanwhile.
    const withCompanion = Effect.gen(function* () {
      const main = yield* Effect.forkChild(program);
      yield* step(driver, journal, "companion");
      return yield* Fiber.join(main);
    });

    const running = runProgram(driver, withCompanion);
    await new Promise((resolve) => setTimeout(resolve, 20));
    journal.complete("companion", "companion");

    const outcome = await running.then(
      (exit) => exit,
      (error: unknown) => error
    );
    const message =
      outcome instanceof Error
        ? outcome.message
        : Exit.isFailure(outcome as Exit.Exit<unknown, unknown>)
          ? JSON.stringify(outcome)
          : "no failure";
    expect(message).toMatch(/unjournaled async|UnjournaledAsync/i);
  });

  it("exposes the diagnostic as a distinct error type", () => {
    expect(new UnjournaledAsyncError("run(x)").message).toMatch(
      /wrap that work in Restate\.run/i
    );
  });
});

/** Let pending microtasks and timers run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Complete `names` as they appear in the journal, one per tick. */
async function settleAll(
  journal: FakeJournal,
  names: readonly string[]
): Promise<void> {
  for (const name of names) {
    for (let i = 0; i < 100 && !journal.has(name); i++) await tick();
    journal.complete(name, name);
    await tick();
  }
}

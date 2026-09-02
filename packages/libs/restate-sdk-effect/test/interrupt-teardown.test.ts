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

// `park`'s interruption hook — the mechanism behind aborting a `Restate.run`
// closure whose awaiting fiber lost a race.
//
// The journal entry is not the thing being torn down: Restate created it and
// will complete it regardless. What has to stop is the *external* work behind
// it, which is why `run` hangs its AbortController on this hook.

import { describe, expect, it } from "vitest";
import { Context, Effect, Fiber } from "effect";
import { Driver } from "../src/internal.js";
import { FakeJournal } from "./harness.js";

const run = <A, E>(driver: Driver, effect: Effect.Effect<A, E, never>) =>
  driver.run(effect, Context.empty());

describe("park interruption hook", () => {
  it("fires when the parked fiber loses a race", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const torn: string[] = [];

    const slow = driver.park(
      "slow",
      () => journal.entry<string>("slow"),
      () => torn.push("slow")
    );
    const fast = driver.park(
      "fast",
      () => journal.entry<string>("fast"),
      () => torn.push("fast")
    );

    const program = Effect.race(slow, fast);
    const pending = run(driver, program);
    // The winner is journaled; the loser is interrupted by Effect.
    await Promise.resolve();
    journal.complete("fast", "fast");

    await expect(pending).resolves.toMatchObject({ value: "fast" });
    expect(torn).toEqual(["slow"]);
  });

  it("does not fire for an operation that settled normally", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const torn: string[] = [];

    const program = driver.park(
      "only",
      () => journal.entry<string>("only"),
      () => torn.push("only")
    );
    const pending = run(driver, program);
    await Promise.resolve();
    journal.complete("only", "done");

    await expect(pending).resolves.toMatchObject({ value: "done" });
    expect(torn).toEqual([]);
  });

  it("fires for each interrupted operation in a wide fan-out", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const torn: string[] = [];
    const names = ["a", "b", "c", "d"];

    const program = Effect.raceAll(
      names.map((name) =>
        driver.park(
          name,
          () => journal.entry<string>(name),
          () => torn.push(name)
        )
      )
    );
    const pending = run(driver, program);
    await Promise.resolve();
    journal.complete("c", "c");

    await expect(pending).resolves.toMatchObject({ value: "c" });
    expect(torn.sort()).toEqual(["a", "b", "d"]);
  });

  it("fires when an enclosing timeout elapses", async () => {
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const torn: string[] = [];

    // The timeout's own timer is a journal entry too; completing it interrupts
    // the operation it wraps.
    const program = Effect.race(
      driver.park(
        "work",
        () => journal.entry<string>("work"),
        () => torn.push("work")
      ),
      Effect.as(
        driver.park("timer", () => journal.entry<string>("timer")),
        "timed out"
      )
    );
    const pending = run(driver, program);
    await Promise.resolve();
    journal.complete("timer", "timer");

    await expect(pending).resolves.toMatchObject({ value: "timed out" });
    expect(torn).toEqual(["work"]);
  });

  it("tears down only the execution that was interrupted", async () => {
    // Two concurrent executions of the *same* effect value. The hook is
    // captured per execution, so interrupting one must not tear down the other.
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const torn: string[] = [];
    let seq = 0;

    const operation = Effect.suspend(() => {
      const name = `op${seq++}`;
      return driver.park(
        name,
        () => journal.entry<string>(name),
        () => torn.push(name)
      );
    });

    const program = Effect.gen(function* () {
      const first = yield* Effect.forkChild(operation);
      const second = yield* Effect.forkChild(operation);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      journal.complete("op1", "second");
      return yield* Fiber.join(second);
    });

    const pending = run(driver, program);
    await expect(pending).resolves.toMatchObject({ value: "second" });
    expect(torn).toEqual(["op0"]);
  });
});

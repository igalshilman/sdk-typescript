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

// Scheduler overhead per durable operation (TODO S7-3).
//
// The journal itself is not exercised here — the fake journal completes
// instantly — so what these measure is the cost this SDK adds around each
// operation: the fiber steps, the drain, and the race bookkeeping. For the
// *journal* cost (entries per operation), see test/journal-cost.test.ts.

import { bench, describe } from "vitest";
import { Context, Effect } from "effect";
import { Driver } from "../src/internal.js";
import { FakeJournal } from "../test/harness.js";

/** A journal that completes every entry the moment it is created. */
class InstantJournal extends FakeJournal {
  override entry<T>(name: string) {
    const entry = super.entry<T>(name);
    this.complete(name, name);
    return entry;
  }
}

const sequential = (steps: number) => async () => {
  const journal = new InstantJournal();
  const driver = new Driver(journal);
  await driver.run(
    Effect.gen(function* () {
      for (let i = 0; i < steps; i++) {
        yield* driver.park(`s${i}`, () => journal.entry<string>(`s${i}`));
      }
    }),
    Context.empty()
  );
};

const concurrent = (steps: number) => async () => {
  const journal = new InstantJournal();
  const driver = new Driver(journal);
  await driver.run(
    Effect.all(
      Array.from({ length: steps }, (_, i) =>
        driver.park(`c${i}`, () => journal.entry<string>(`c${i}`))
      ),
      { concurrency: "unbounded" }
    ),
    Context.empty()
  );
};

const pureEffect = (steps: number) => async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < steps; i++) {
        yield* Effect.succeed(i);
      }
    })
  );
};

describe("driver overhead", () => {
  bench("100 sequential durable operations", sequential(100));
  bench("100 concurrent durable operations", concurrent(100));
  bench("100 plain Effect steps (baseline, no journal)", pureEffect(100));
});

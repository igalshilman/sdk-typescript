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

// The journal cost model (DESIGN §3.5, TODO S7-2), asserted rather than
// described: sequential code pays nothing for being run on this SDK, and
// concurrency costs one combinator entry per delivery while more than one
// durable operation is pending.

import { describe, expect, it } from "vitest";
import { Context, Effect } from "effect";
import { Driver } from "../src/internal.js";
import { FakeJournal } from "./harness.js";

/** A journal that completes every entry the moment it is created. */
class InstantJournal extends FakeJournal {
  override entry<T>(name: string) {
    const entry = super.entry<T>(name);
    this.complete(name, name);
    return entry;
  }
}

async function costOf(
  program: (
    driver: Driver,
    journal: FakeJournal
  ) => Effect.Effect<unknown, unknown, never>
): Promise<{ entries: number; combinators: number }> {
  const journal = new InstantJournal();
  const driver = new Driver(journal);
  await driver.run(program(driver, journal), Context.empty());
  return {
    entries: journal.created.length,
    combinators: journal.raceWinners.length,
  };
}

describe("journal cost", () => {
  it("sequential work costs exactly one entry per operation", async () => {
    const cost = await costOf((driver, journal) =>
      Effect.gen(function* () {
        for (let i = 0; i < 10; i++) {
          yield* driver.park(`s${i}`, () => journal.entry<string>(`s${i}`));
        }
      })
    );
    expect(cost.entries).toBe(10);
    // No combinator entries at all: one pending source is awaited directly.
    expect(cost.combinators).toBe(0);
  });

  it("concurrency costs at most one combinator entry per delivery", async () => {
    const width = 10;
    const cost = await costOf((driver, journal) =>
      Effect.all(
        Array.from({ length: width }, (_, i) =>
          driver.park(`c${i}`, () => journal.entry<string>(`c${i}`))
        ),
        { concurrency: "unbounded" }
      )
    );
    expect(cost.entries).toBe(width);
    // One race per tick while >1 source is pending; the last delivery has a
    // single source left and is awaited directly.
    expect(cost.combinators).toBeLessThanOrEqual(width - 1);
    expect(cost.combinators).toBeGreaterThan(0);
  });

  it("a race over two operations costs one combinator entry", async () => {
    const cost = await costOf((driver, journal) =>
      Effect.race(
        driver.park("a", () => journal.entry<string>("a")),
        driver.park("b", () => journal.entry<string>("b"))
      )
    );
    expect(cost.entries).toBe(2);
    expect(cost.combinators).toBe(1);
  });
});

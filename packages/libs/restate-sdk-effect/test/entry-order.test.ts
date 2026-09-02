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

// Journal *entry creation* order.
//
// Restate orders deliveries to a target by the order their entries were
// created, so this is semantics, not bookkeeping: two calls to the same virtual
// object arrive in entry order. Effects are lazy, which makes "create the entry
// here" a question about when a child fiber first runs — these tests pin the
// answer down.
//
// Found by sdk-test-suite's `CallOrdering`, which a lazily-held call effect
// fails: see `test-services/src/proxy.ts`.

import { describe, expect, it } from "vitest";
import { Context, Effect, Fiber } from "effect";
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

async function orderOf(
  program: (
    driver: Driver,
    journal: FakeJournal
  ) => Effect.Effect<unknown, unknown, never>
): Promise<string[]> {
  const journal = new InstantJournal();
  const driver = new Driver(journal);
  await driver.run(program(driver, journal), Context.empty());
  return journal.created;
}

/** An operation that parks, like a call: `park` creates the entry. */
const parking = (driver: Driver, journal: FakeJournal, name: string) =>
  driver.park(name, () => journal.entry<string>(name));

/** An operation that creates its entry synchronously, like a send. */
const synchronous = (journal: FakeJournal, name: string) =>
  Effect.sync(() => {
    journal.entry<string>(name);
  });

describe("journal entry creation order", () => {
  it("Effect.all starts children in array order", async () => {
    const order = await orderOf((driver, journal) =>
      Effect.all(
        ["a", "b", "c"].map((n) => parking(driver, journal, n)),
        { concurrency: "unbounded" }
      )
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("Effect.all keeps array order across parking and synchronous ops", async () => {
    // The shape of `Proxy/manyCalls`: calls and sends interleaved. Entry order
    // must follow the request list, not the parking/synchronous split.
    const order = await orderOf((driver, journal) =>
      Effect.all(
        [
          parking(driver, journal, "call0"),
          synchronous(journal, "send1"),
          parking(driver, journal, "call2"),
        ],
        { concurrency: "unbounded", discard: true }
      )
    );
    expect(order).toEqual(["call0", "send1", "call2"]);
  });

  it("an effect held to await later creates nothing until it runs", async () => {
    // The bug this file exists for. Building the effect is free; a later
    // synchronous op therefore claims the earlier entry.
    const order = await orderOf((driver, journal) =>
      Effect.gen(function* () {
        const later = parking(driver, journal, "call0");
        yield* synchronous(journal, "send1");
        yield* later;
      })
    );
    expect(order).toEqual(["send1", "call0"]);
  });

  it("forkChild alone does not create the entry either", async () => {
    // The obvious repair, and still wrong: the child is scheduled, not run, so
    // the parent's next synchronous op still gets there first. Forking buys
    // concurrency, never entry order.
    const order = await orderOf((driver, journal) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          parking(driver, journal, "call0")
        );
        yield* synchronous(journal, "send1");
        yield* Fiber.await(fiber);
      })
    );
    expect(order).toEqual(["send1", "call0"]);
  });

  it("forkChild then an explicit yield does create it", async () => {
    // Yielding hands the dispatcher to the child, which runs until it parks —
    // creating its entry. Correct, but `Effect.all` says it without relying on
    // the scheduler's FIFO discipline.
    const order = await orderOf((driver, journal) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          parking(driver, journal, "call0")
        );
        yield* Effect.yieldNow;
        yield* synchronous(journal, "send1");
        yield* Fiber.await(fiber);
      })
    );
    expect(order).toEqual(["call0", "send1"]);
  });
});

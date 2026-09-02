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

// The claim this package exists for (DESIGN §2, TODO S4-2).
// =============================================================================
//
// Run a concurrent program twice:
//
//   live    entries complete after arbitrary real-world delays, so who wakes
//           first is decided by timing; each race records its winner
//   replay  every entry is already complete the moment it is created (a journal
//           serving recorded results), and each race resolves to its *recorded*
//           winner
//
// The journal-entry creation sequence must be byte-identical between the two.
// If it is not, a real invocation would fail with a journal mismatch. Fuzzed
// across seeds, and across program shapes that are all "banned or impossible"
// in a thin Effect binding: concurrent forks over durable steps, races, nested
// concurrency, and in-memory hand-off between fibers.

import { describe, expect, it } from "vitest";
import { Context, Effect, Exit, Fiber, Queue } from "effect";
import { Driver } from "../src/internal.js";
import { FakeJournal, type JournalMode } from "./harness.js";

/**
 * A journal that completes its own entries: after a seeded delay when running
 * live, immediately when replaying.
 */
class AutoJournal extends FakeJournal {
  constructor(
    mode: JournalMode,
    winners: readonly string[],
    private readonly delayOf: (name: string) => number
  ) {
    super(mode, winners);
  }

  override entry<T>(name: string) {
    const entry = super.entry<T>(name);
    const delay = this.delayOf(name);
    if (delay < 0) {
      this.complete(name, name);
    } else {
      setTimeout(() => this.complete(name, name), delay);
    }
    return entry;
  }
}

/** Deterministic small-int PRNG, so a failing seed reproduces exactly. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

type Program = (
  driver: Driver,
  journal: FakeJournal
) => Effect.Effect<unknown, unknown, never>;

/** N fibers each taking `steps` durable steps — the basic interleaving shape. */
const fanOut =
  (ids: readonly string[], steps: number): Program =>
  (driver, journal) => {
    const worker = (id: string) =>
      Effect.gen(function* () {
        const seen: string[] = [];
        for (let i = 0; i < steps; i++) {
          seen.push(
            yield* driver.park(`${id}.${i}`, () =>
              journal.entry<string>(`${id}.${i}`)
            )
          );
        }
        return seen.join(">");
      });
    return Effect.all(ids.map(worker), { concurrency: "unbounded" });
  };

/** A race whose loser is torn down, followed by more durable work. */
const racy: Program = (driver, journal) =>
  Effect.gen(function* () {
    const winner = yield* Effect.race(
      driver.park("race.a", () => journal.entry<string>("race.a")),
      driver.park("race.b", () => journal.entry<string>("race.b"))
    );
    const after = yield* driver.park(`after.${winner}`, () =>
      journal.entry<string>(`after.${winner}`)
    );
    return `${winner}/${after}`;
  });

/** Producer/consumer over an in-memory queue, both sides doing durable work. */
const queueHandoff: Program = (driver, journal) =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<string>();
    const producer = yield* Effect.forkChild(
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          const value = yield* driver.park(`produce.${i}`, () =>
            journal.entry<string>(`produce.${i}`)
          );
          yield* Queue.offer(queue, value);
        }
      })
    );
    const consumed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const value = yield* Queue.take(queue);
      consumed.push(
        yield* driver.park(`consume.${value}`, () =>
          journal.entry<string>(`consume.${value}`)
        )
      );
    }
    yield* Fiber.join(producer);
    return consumed.join(",");
  });

/** Nested concurrency: forks that themselves fan out. */
const nested: Program = (driver, journal) =>
  Effect.gen(function* () {
    const branch = (id: string) =>
      Effect.gen(function* () {
        const head = yield* driver.park(`${id}.head`, () =>
          journal.entry<string>(`${id}.head`)
        );
        const [x, y] = yield* Effect.all(
          [
            driver.park(`${id}.x`, () => journal.entry<string>(`${id}.x`)),
            driver.park(`${id}.y`, () => journal.entry<string>(`${id}.y`)),
          ],
          { concurrency: "unbounded" }
        );
        return `${head}(${x},${y})`;
      });
    return yield* Effect.all([branch("p"), branch("q")], {
      concurrency: "unbounded",
    });
  });

const programs: ReadonlyArray<readonly [string, Program]> = [
  ["fan-out over durable steps", fanOut(["a", "b", "c"], 3)],
  ["race with torn-down loser", racy],
  ["queue hand-off between fibers", queueHandoff],
  ["nested concurrency", nested],
];

type Run = {
  readonly created: readonly string[];
  readonly winners: readonly string[];
  readonly result: unknown;
};

async function live(program: Program, seed: number): Promise<Run> {
  const next = rng(seed);
  const delays = new Map<string, number>();
  const journal = new AutoJournal("record", [], (name) => {
    // Stable per name so a retried entry name keeps its delay; arbitrary
    // otherwise, which is the point.
    const existing = delays.get(name);
    if (existing !== undefined) return existing;
    const delay = Math.floor(next() * 4);
    delays.set(name, delay);
    return delay;
  });
  const driver = new Driver(journal);
  const exit = await driver.run(program(driver, journal), Context.empty());
  return {
    created: [...journal.created],
    winners: [...journal.raceWinners],
    result: Exit.isSuccess(exit) ? exit.value : exit,
  };
}

async function replay(program: Program, recorded: Run): Promise<Run> {
  const journal = new AutoJournal("replay", recorded.winners, () => -1);
  const driver = new Driver(journal);
  const exit = await driver.run(program(driver, journal), Context.empty());
  return {
    created: [...journal.created],
    winners: [...journal.raceWinners],
    result: Exit.isSuccess(exit) ? exit.value : exit,
  };
}

describe("replay equivalence", () => {
  for (const [name, program] of programs) {
    it(`reproduces the journal of "${name}" across seeds`, async () => {
      for (let seed = 1; seed <= 8; seed++) {
        const recorded = await live(program, seed);
        const replayed = await replay(program, recorded);

        expect(replayed.created, `seed ${seed}: creation order`).toEqual(
          recorded.created
        );
        expect(replayed.result, `seed ${seed}: result`).toEqual(
          recorded.result
        );
      }
    });
  }

  it("actually explores different delivery orders", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const run = await live(fanOut(["a", "b", "c"], 3), seed);
      orders.add(run.created.join(","));
    }
    // If every seed produced the same interleaving the equivalence test above
    // would be vacuous.
    expect(orders.size).toBeGreaterThan(1);
  });
});

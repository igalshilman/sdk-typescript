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

// A Restate-free journal (the counterpart of gen's fake AwaitableLib).
// =============================================================================
//
// `FakeJournal` implements the driver's `RestateLib` seam with hand-controlled
// deferreds, plus the one behaviour that matters for replay: a race *records its
// winner* and, in replay mode, resolves to the recorded winner regardless of
// which source settled first in real time.
//
// That is exactly Restate's contract (DESIGN §2, fact 2), so a program driven by
// this harness can be run twice — once "live" with an arbitrary completion
// order, once "replayed" with everything already settled — and the two runs must
// create the same journal entries in the same order.

import type { Awaitable, RestateLib, Settled } from "../src/internal.js";

/** Marker rejection classified as invocation cancellation by the fake lib. */
export class FakeCancelled extends Error {
  constructor() {
    super("fake cancellation");
    this.name = "FakeCancelled";
  }
}

/** Marker rejection classified as attempt suspension by the fake lib. */
export class FakeSuspended extends Error {
  constructor() {
    super("fake suspension");
    this.name = "FakeSuspended";
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing may reject before the driver awaits it; keep Node quiet meanwhile.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** A journal entry the test controls. Doubles as the driver's `Awaitable`. */
export class FakeEntry<T> implements Awaitable<T> {
  /** The entry this value derives from — survives `.map`, so races can name it. */
  readonly origin: string;
  private readonly source: Promise<unknown>;
  private readonly project: ((v: unknown, e: unknown) => T) | undefined;

  constructor(
    origin: string,
    source: Promise<unknown>,
    project?: (v: unknown, e: unknown) => T
  ) {
    this.origin = origin;
    this.source = source;
    this.project = project;
  }

  private settled(): Promise<T> {
    const project = this.project;
    if (project === undefined) return this.source as Promise<T>;
    return this.source.then(
      (value) => project(value, undefined),
      (error: unknown) => {
        // Restate hands terminal failures to the mapper; anything else, such as
        // a suspension arriving on the aggregate, keeps propagating.
        if (error instanceof FakeSuspended || error instanceof FakeCancelled) {
          throw error;
        }
        return project(undefined, error);
      }
    );
  }

  then<A = T, B = never>(
    onfulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return this.settled().then(onfulfilled, onrejected);
  }

  map<U>(f: (v: T | undefined, e: unknown) => U): Awaitable<U> {
    return new FakeEntry<U>(this.origin, this.settled(), (v, e) =>
      f(v as T | undefined, e)
    );
  }
}

export type JournalMode = "record" | "replay";

export class FakeJournal implements RestateLib {
  /** Names of entries in creation order — the sequence replay must reproduce. */
  readonly created: string[] = [];
  /** Winner of each race, in race order. Replayed back in `replay` mode. */
  readonly raceWinners: string[] = [];
  /** Names of entries the driver actually awaited alone (single-source ticks). */
  readonly soloAwaits: string[] = [];

  private readonly entries = new Map<string, Deferred<unknown>>();
  private raceIndex = 0;

  constructor(
    readonly mode: JournalMode = "record",
    recordedWinners: readonly string[] = []
  ) {
    this.raceWinners = [...recordedWinners];
  }

  /** Create an entry. Returns the awaitable the driver parks on. */
  entry<T>(name: string): FakeEntry<T> {
    if (this.entries.has(name)) {
      throw new Error(`duplicate journal entry: ${name}`);
    }
    const d = deferred<unknown>();
    this.entries.set(name, d);
    this.created.push(name);
    return new FakeEntry<T>(name, d.promise);
  }

  /** Complete an entry with a value. May happen before it is awaited. */
  complete(name: string, value: unknown = undefined): void {
    this.deferredFor(name).resolve(value);
  }

  /** Complete an entry with a failure. */
  fail(name: string, error: unknown): void {
    this.deferredFor(name).reject(error);
  }

  /** True once `name` exists. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  private deferredFor(name: string): Deferred<unknown> {
    const d = this.entries.get(name);
    if (d === undefined) throw new Error(`no such journal entry: ${name}`);
    return d;
  }

  // ---- RestateLib ----------------------------------------------------------

  race<T>(items: readonly Awaitable<T>[]): Awaitable<T> {
    const entries = items as readonly FakeEntry<T>[];
    const index = this.raceIndex++;

    if (this.mode === "replay") {
      const winner = this.raceWinners[index];
      if (winner === undefined) {
        throw new Error(`replay: no recorded winner for race #${index}`);
      }
      const item = entries.find((entry) => entry.origin === winner);
      if (item === undefined) {
        throw new Error(
          `replay divergence: race #${index} recorded winner "${winner}" but ` +
            `the pending set is [${entries.map((e) => e.origin).join(", ")}]`
        );
      }
      return item;
    }

    const race = Promise.race(
      entries.map((entry) =>
        Promise.resolve(entry).then(
          (value) => ({ origin: entry.origin, value }),
          (error: unknown) => {
            throw error;
          }
        )
      )
    ).then(({ origin, value }) => {
      this.raceWinners[index] = origin;
      return value;
    });
    return new FakeEntry<T>("<race>", race);
  }

  isCancellation(e: unknown): boolean {
    return e instanceof FakeCancelled;
  }

  isSuspension(e: unknown): boolean {
    return e instanceof FakeSuspended;
  }

  /** Note a single-source tick, called from the test's driver wrapper. */
  noteSoloAwait(name: string): void {
    this.soloAwaits.push(name);
  }
}

/** A settled value, for tests that build `Settled` directly. */
export const ok = (value: unknown): Settled => ({ ok: true, value });
/** A settled failure. */
export const err = (error: unknown): Settled => ({ ok: false, error });

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

// The journal multiplexer (DESIGN §3.2).
// =============================================================================
//
// One `Driver` per invocation. It owns:
//
//   - the deterministic scheduler (so every fiber step is a task it dispatches),
//   - the set of pending journal *sources* (durable ops whose fibers are
//     parked),
//   - the tick loop: drain to quiescence, race the pending sources, deliver the
//     journaled winner, drain again,
//   - cancellation (journaled `CancelledError` -> root interrupt) and the
//     AbortSignal cascade into in-flight `run` closures,
//   - the unjournaled-async detector.
//
// Invariants (the Effect counterparts of gen's S1-S3):
//
//   D1. The ONLY asynchronous suspension point is the single `await` per tick,
//       over one source or over `lib.race(sources)`. In production that race is
//       a journaled combinator, so its winner replays identically. Drains and
//       deliveries are synchronous between two such awaits.
//   D2. Fibers advance ONLY inside a drain or inside the synchronous re-entry
//       of a delivery. While the driver is parked, nothing may run — a journal
//       op created in that window is definitionally unjournaled async (§5).
//   D3. Every interrupt originates deterministically: fiber-initiated ones are
//       ordinary execution; the only external initiator is this loop reacting
//       to a journaled cancellation, at a fixed point in the tick.

import { Effect, type Exit, type Context, type Fiber } from "effect";
import {
  DeterministicScheduler,
  drainToQuiescence,
  forkRoot,
  interruptRoot,
  pollExit,
  withScheduler,
} from "./effect4.js";
import type { Awaitable, RestateLib, Settled } from "./lib.js";
import { linkAbortController, neverAbortedSignal } from "./abort.js";

/** A durable op whose owning fiber is parked, waiting for the journal. */
type Source = {
  readonly id: number;
  readonly promise: Awaitable<unknown>;
  readonly deliver: (settled: Settled) => void;
  settled: boolean;
};

/** Handle returned to a call site so it can deregister on interrupt. */
export type SourceHandle = { readonly id: number };

/**
 * Thrown when the attempt ends underneath the driver (suspension, stream
 * close). The SDK has already unwound the handler by racing its own
 * attempt-end promise, so nobody observes this — it exists so the driver stops
 * driving instead of holding a pending await forever.
 */
export class AttemptEndedError extends Error {
  constructor(reason?: unknown) {
    super("Restate attempt ended", { cause: reason });
    this.name = "AttemptEndedError";
  }
}

/**
 * Thrown when user code created a journal op while the driver was parked: some
 * non-journal event (a raw `setTimeout`, an unwrapped promise) woke a fiber.
 * Terminal, because retrying runs the same code and fails the same way.
 */
export class UnjournaledAsyncError extends Error {
  constructor(op: string) {
    super(
      `@restatedev/restate-sdk-effect: unjournaled async detected — the ` +
        `durable operation "${op}" was created while no fiber should have ` +
        `been running. Something outside the journal (a raw setTimeout, an ` +
        `unwrapped Promise, a library callback) resumed a fiber. Wrap that ` +
        `work in Restate.run.`
    );
    this.name = "UnjournaledAsyncError";
  }
}

export interface DriverOptions {
  /**
   * Parent of every AbortController the driver creates — production passes the
   * SDK's `attemptCompletedSignal`. Unlike cancellation, a parent abort is
   * sticky: an ended attempt never resumes.
   */
  readonly parentSignal?: AbortSignal;
  /** Bound on drain turns per tick; see `drainToQuiescence`. */
  readonly maxDrainTurns?: number;
}

export class Driver {
  readonly scheduler = new DeterministicScheduler();

  private readonly lib: RestateLib;
  private readonly parentSignal: AbortSignal;
  private readonly maxDrainTurns: number | undefined;

  private readonly sources = new Map<number, Source>();
  private nextSourceId = 1;

  /** True while the driver awaits the journal: no fiber may run (D2). */
  private parked = false;
  /** Recorded rule-1 violation; converted into a terminal failure at the end. */
  private violation: Error | undefined;
  /** How many cancellations the loop has observed. */
  private cancellations = 0;

  /**
   * Aborted when cancellation arrives or the parent signal fires, then
   * *replaced* — AbortControllers are one-way, so recovery (a compensation
   * running after cancellation) must see a fresh, unaborted signal.
   */
  private abortController: AbortController;

  constructor(lib: RestateLib, options?: DriverOptions) {
    this.lib = lib;
    this.parentSignal = options?.parentSignal ?? neverAbortedSignal();
    this.maxDrainTurns = options?.maxDrainTurns;
    this.abortController = linkAbortController(this.parentSignal);
  }

  /**
   * The signal to hand to `run` closures. Aborts on invocation cancellation and
   * on attempt end; after a cancellation has been delivered this returns a
   * fresh signal, so post-cancellation cleanup can still do real work.
   */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  // ---- journal sources -----------------------------------------------------

  /**
   * Register a durable op's promise as a pending source. Called synchronously
   * at the op's call site, which is what fixes journal-entry creation order.
   */
  register(
    promise: Awaitable<unknown>,
    deliver: (settled: Settled) => void
  ): SourceHandle {
    const source: Source = {
      id: this.nextSourceId++,
      promise,
      deliver,
      settled: false,
    };
    this.sources.set(source.id, source);
    return source;
  }

  /**
   * Drop a source without delivering it — the owning fiber was interrupted (a
   * race loser, a scope teardown). The underlying journal entry still completes
   * whenever it completes; nobody reads it.
   */
  deregister(handle: SourceHandle): void {
    this.sources.delete(handle.id);
  }

  /** Number of pending sources (diagnostics/tests). */
  get pendingSources(): number {
    return this.sources.size;
  }

  /**
   * Called by every durable op *before* it creates its journal entry. This is
   * the primary unjournaled-async check (DESIGN §5): we own every journal call
   * site, so an op created while parked is a certain rule-1 violation.
   */
  enterJournalOp(op: string): void {
    if (!this.parked) return;
    const err = new UnjournaledAsyncError(op);
    // Record it so the invocation fails terminally even if user code swallows
    // the throw, and throw so the author sees it at the offending call site.
    this.violation ??= err;
    throw err;
  }

  /**
   * Park the calling fiber on a durable op.
   *
   * `create` runs synchronously inside the fiber's step, so the journal entry
   * is created in deterministic order. The canceler deregisters the source when
   * the fiber is interrupted, which keeps the pending-source set — and
   * therefore each race's children — replay-stable.
   */
  park<A>(
    op: string,
    create: () => Awaitable<A>,
    onInterrupt?: () => void
  ): Effect.Effect<A, unknown> {
    return Effect.callback<A, unknown>((resume) => {
      this.enterJournalOp(op);
      let settledHere = false;
      const handle = this.register(create(), (settled) => {
        settledHere = true;
        resume(
          settled.ok
            ? Effect.succeed(settled.value as A)
            : Effect.fail(settled.error)
        );
      });
      // Effect runs this canceler on interruption *and* nothing else; a source
      // that settled normally never reaches it. The `settledHere` guard is
      // belt-and-braces so `onInterrupt` cannot fire for a completed operation.
      return Effect.sync(() => {
        this.deregister(handle);
        if (!settledHere) onInterrupt?.();
      });
    });
  }

  // ---- driving -------------------------------------------------------------

  /**
   * Run `effect` as the invocation's root fiber and drive it to completion.
   *
   * Resolves with the root fiber's `Exit`. Rejects only when the *attempt*
   * cannot continue: suspension (rethrown verbatim, with no finalizers run —
   * the invocation resumes in a later attempt and replay rebuilds the fibers),
   * attempt end, or a driver-level failure.
   */
  async run<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    context: Context.Context<R>
  ): Promise<Exit.Exit<A, E>> {
    const attemptEnded = this.attemptEndedPromise();
    const root = forkRoot(effect, withScheduler(context, this.scheduler));
    await this.drain();

    let ticks = 0;
    while (pollExit(root) === undefined) {
      if (++ticks > MAX_TICKS_WITHOUT_PROGRESS_GUARD) {
        throw new Error(
          "@restatedev/restate-sdk-effect: driver exceeded " +
            `${MAX_TICKS_WITHOUT_PROGRESS_GUARD} ticks without the handler ` +
            "completing; this is an SDK bug, please report it"
        );
      }

      const pending = [...this.sources.values()];
      if (pending.length === 0) {
        // Fibers are alive but nothing is pending on the journal: a wait cycle
        // (two fibers awaiting each other), or an in-memory primitive nobody
        // will ever complete.
        throw new Error(
          "@restatedev/restate-sdk-effect: the handler is stuck — fibers are " +
            "still running but no durable operation is pending. This is a " +
            "deadlock in the handler (for example a Deferred or Queue that " +
            "nothing completes)."
        );
      }

      const winner = await this.awaitOne(pending, attemptEnded);
      if (winner.kind === "cancelled") {
        this.onCancellation(root, pending, winner.error);
        await this.drain();
        continue;
      }

      const source = this.sources.get(winner.id);
      if (source === undefined || source.settled) continue;
      source.settled = true;
      this.sources.delete(source.id);

      // Suspension can also arrive through `.map` as a settled failure (the SDK
      // hands any RestateError to the mapper). It must never reach a fiber:
      // finalizers must not run when an attempt suspends.
      if (!winner.settled.ok && this.lib.isSuspension(winner.settled.error)) {
        throw winner.settled.error;
      }

      source.deliver(winner.settled);
      await this.drain();
    }

    if (this.violation !== undefined) throw this.violation;
    return pollExit(root)!;
  }

  /**
   * One tick's suspension point (D1). Tags each pending source with its id,
   * then awaits a single source directly (no combinator entry — the sequential
   * case pays nothing) or races them (journaled winner).
   */
  private async awaitOne(
    pending: readonly Source[],
    attemptEnded: Promise<never>
  ): Promise<TickOutcome> {
    const tagged = pending.map((source) =>
      source.promise.map(
        (value, error): TickWinner => ({
          kind: "settled",
          id: source.id,
          settled:
            error !== undefined
              ? { ok: false, error }
              : { ok: true, value: value },
        })
      )
    );

    // `tagged[0]` is a mapped wrapper, not the source itself: cancellation
    // poisons only the throwaway wrapper, leaving the source re-awaitable.
    const journal =
      tagged.length === 1
        ? (tagged[0] as Awaitable<TickWinner>)
        : this.lib.race(tagged);

    this.setParked(true);
    try {
      return await Promise.race([journal, attemptEnded]);
    } catch (e) {
      if (this.lib.isSuspension(e)) throw e;
      if (this.lib.isCancellation(e)) return { kind: "cancelled", error: e };
      throw e;
    } finally {
      this.setParked(false);
    }
  }

  /**
   * Invocation cancellation (DESIGN §3.4). Abort in-flight `run` closures, then
   * interrupt the *root* fiber: Effect's structured concurrency tears down the
   * whole tree in order, finalizers run (and may journal — the journal is not
   * poisoned), and uninterruptible regions are honoured.
   *
   * On a repeat cancellation — the SDK delivers the signal once per cancel, so
   * this is a safety net — the error is instead fanned out to every pending
   * source, so fibers that cannot be interrupted (uninterruptible regions,
   * finalizers) stop parking and the loop cannot spin.
   */
  private onCancellation(
    root: Fiber.Fiber<unknown, unknown>,
    pending: readonly Source[],
    cancelled: unknown
  ): void {
    this.abortController.abort(cancelled);
    this.abortController = linkAbortController(this.parentSignal);

    if (this.cancellations++ === 0) {
      interruptRoot(root);
      return;
    }
    for (const source of pending) {
      if (source.settled) continue;
      source.settled = true;
      this.sources.delete(source.id);
      source.deliver({ ok: false, error: cancelled });
    }
  }

  private setParked(parked: boolean): void {
    this.parked = parked;
    this.scheduler.dispatcher.parked = parked;
  }

  private drain(): Promise<void> {
    return drainToQuiescence(this.scheduler.dispatcher, this.maxDrainTurns);
  }

  /**
   * A promise that rejects when the attempt ends. Created once and reused by
   * every tick, so the driver adds at most one listener to the signal.
   */
  private attemptEndedPromise(): Promise<never> {
    const signal = this.parentSignal;
    const promise = signal.aborted
      ? Promise.reject<never>(new AttemptEndedError(signal.reason))
      : new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new AttemptEndedError(signal.reason)),
            { once: true }
          );
        });
    // The attempt usually ends *after* the driver is done, when nobody is
    // racing this promise any more. Mark it handled so a normal completion does
    // not surface as an unhandled rejection.
    promise.catch(() => undefined);
    return promise;
  }
}

type TickWinner = {
  readonly kind: "settled";
  readonly id: number;
  readonly settled: Settled;
};

type TickOutcome =
  | TickWinner
  | { readonly kind: "cancelled"; readonly error: unknown };

/**
 * Ceiling on tick count. Each tick either delivers a journal completion or
 * tears down after a cancellation, so a handler that exceeds this is looping in
 * a way no real workflow does.
 */
const MAX_TICKS_WITHOUT_PROGRESS_GUARD = 10_000_000;

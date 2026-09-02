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

// The Effect-4 seam.
// =============================================================================
//
// Everything this package needs from Effect's *runtime* — as opposed to its
// user-facing combinators — lives here: the Scheduler/SchedulerDispatcher
// implementation, the drain-to-quiescence primitive, and the fork / interrupt /
// observe entry points. Effect 4 is pre-release; when an RC (or eventually
// Effect 5) moves these, this is the file that moves with it.
//
// Verified against effect@4.0.0-rc.112 (see DESIGN.md §8.1):
//
//   - Effect 4 creates a dispatcher *per fiber*, lazily
//     (`fiber._dispatcher ??= fiber.currentScheduler.makeDispatcher()`), so a
//     `makeDispatcher()` that returns one shared instance gives the whole
//     invocation a single global FIFO task queue.
//   - `executionMode: "sync"` + `shouldYield: () => false` means no involuntary
//     op-budget yields: 20k sequential ops run to completion inside `runFork`
//     without scheduling a single task. `MaxOpsBeforeYield` /
//     `PreventSchedulerYield` are therefore not needed.
//   - `SchedulerDispatcher.flush()` is a synchronous drain. Effect's own
//     concurrency combinators need a microtask turn between flushes, hence
//     `drainToQuiescence`.
//   - A root fiber's `Exit` is withheld until its `forkChild`/`forkScoped`
//     descendants have finished (including finalizers that park on something
//     async), so "root fiber settled" is a complete stop condition for the
//     driver — interrupt-then-join comes for free.
//   - External interrupt delivery is synchronous: `interruptUnsafe()` re-enters
//     the fiber at our call site rather than scheduling a task.

import { Context, Effect, type Exit, type Fiber, Scheduler } from "effect";

/**
 * A dispatcher that never self-schedules. The driver owns when tasks run: they
 * accumulate here and execute inside `flush()`.
 *
 * Lower priority runs first, FIFO within a priority — the same ordering as
 * Effect's own `MixedSchedulerDispatcher`, so programs behave identically to
 * how they would under the default scheduler for any given delivery order.
 */
export class DeterministicDispatcher implements Scheduler.SchedulerDispatcher {
  /** `[priority, tasks]`, ascending by priority. */
  private buckets: Array<[number, Array<() => void>]> = [];
  /** Total tasks executed by this dispatcher (diagnostics/tests). */
  dispatched = 0;
  /**
   * When true, the driver is parked on a journal source and no fiber should be
   * running. A task scheduled in this state is a supplementary signal that
   * something woke a fiber from outside the journal (DESIGN §5).
   */
  parked = false;
  /** Tasks scheduled while `parked` — see {@link parked}. */
  scheduledWhileParked = 0;

  scheduleTask(task: () => void, priority: number): void {
    if (this.parked) this.scheduledWhileParked++;
    let bucket = this.buckets.find(([p]) => p === priority);
    if (bucket === undefined) {
      bucket = [priority, []];
      this.buckets.push(bucket);
      this.buckets.sort((a, b) => a[0] - b[0]);
    }
    bucket[1].push(task);
  }

  /** Number of tasks waiting to run. */
  get pending(): number {
    return this.buckets.reduce((n, [, tasks]) => n + tasks.length, 0);
  }

  /**
   * Run every pending task, including tasks they schedule, until the queue is
   * empty. Reentrant: Effect calls `flush()` from inside tasks (e.g. `Schema`
   * forcing a synchronous decode), and because each round splices the buckets
   * out before running them, no task can run twice.
   */
  flush(): void {
    let rounds = 0;
    while (this.pending > 0) {
      const buckets = this.buckets;
      this.buckets = [];
      for (const [, tasks] of buckets) {
        for (const task of tasks) {
          this.dispatched++;
          task();
        }
      }
      if (++rounds > 1_000_000) {
        throw new Error(
          "@restatedev/restate-sdk-effect: scheduler drain did not converge " +
            "(a task keeps scheduling more tasks)"
        );
      }
    }
  }
}

/**
 * Effect's `Scheduler`, implemented so that this package owns every fiber step.
 *
 * One dispatcher instance is shared by every fiber of the invocation, which is
 * what makes fiber interleaving a pure function of (program, delivery order).
 */
export class DeterministicScheduler implements Scheduler.Scheduler {
  readonly executionMode = "sync" as const;
  readonly dispatcher = new DeterministicDispatcher();
  /** How many fibers asked for a dispatcher (diagnostics/tests). */
  makeDispatcherCalls = 0;

  /** Never yield on Effect's op budget; only explicit yields park a fiber. */
  shouldYield(_fiber: Fiber.Fiber<unknown, unknown>): boolean {
    return false;
  }

  makeDispatcher(): Scheduler.SchedulerDispatcher {
    this.makeDispatcherCalls++;
    return this.dispatcher;
  }
}

/**
 * Drain the dispatcher until no fiber can make progress.
 *
 * `flush()` alone is not enough: Effect's concurrency combinators hand work to
 * the microtask queue, so quiescence is "an empty task queue that a microtask
 * turn does not refill". Bounded — non-convergence is a bug, and must fail
 * loudly rather than spin forever.
 */
export async function drainToQuiescence(
  dispatcher: DeterministicDispatcher,
  maxTurns = 10_000
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    dispatcher.flush();
    await Promise.resolve();
    if (dispatcher.pending === 0) return;
  }
  throw new Error(
    "@restatedev/restate-sdk-effect: the Effect runtime did not reach " +
      `quiescence within ${maxTurns} drain turns`
  );
}

/**
 * Install the deterministic scheduler on a context. `Scheduler.Scheduler` is a
 * fiber-cached `Context.Reference`, so every descendant fiber inherits it.
 */
export function withScheduler<R>(
  context: Context.Context<R>,
  scheduler: DeterministicScheduler
): Context.Context<R> {
  return Context.add(context, Scheduler.Scheduler, scheduler);
}

/** Fork `effect` as the invocation's root fiber against `context`. */
export function forkRoot<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  context: Context.Context<R>
): Fiber.Fiber<A, E> {
  return Effect.runForkWith(context)(effect);
}

/**
 * Interrupt the root fiber. In Effect 4 this re-enters the fiber synchronously
 * (finalizers start inside this call), so the driver must keep going afterwards:
 * a finalizer may park on a fresh journal source.
 */
export function interruptRoot<A, E>(fiber: Fiber.Fiber<A, E>): void {
  fiber.interruptUnsafe();
}

/** The fiber's `Exit`, or `undefined` while it is still running. */
export function pollExit<A, E>(
  fiber: Fiber.Fiber<A, E>
): Exit.Exit<A, E> | undefined {
  return fiber.pollUnsafe();
}

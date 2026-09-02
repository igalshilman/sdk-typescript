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

// The journal seam (mirrors `restate-sdk-gen`'s `AwaitableLib`).
// =============================================================================
//
// The driver reaches journal-backed work through this tiny interface only.
// Production wires it to `restate.RestatePromise`; tests wire it to
// hand-controlled deferreds, which is what makes the determinism suite possible
// without a Restate runtime.
//
// Surface used by the driver:
//   - awaitability (`Awaitable<T>` is a thenable)
//   - `.map((v, e) => U)`: project a settled state — Restate's own shape, one
//     callback receiving either the value or the error. Used to tag sources
//     with their identity before racing them.
//   - `race` over an array of awaitables (journaled winner in production)
//   - classification of the two settlements that are not ordinary results:
//     invocation cancellation and attempt suspension.

/** A journal-backed promise. Structurally satisfied by `RestatePromise`. */
export interface Awaitable<T> extends PromiseLike<T> {
  /**
   * Project a settled state into a new awaitable. The callback receives
   * `(value, undefined)` on success or `(undefined, error)` on rejection.
   */
  map<U>(f: (v: T | undefined, e: unknown) => U): Awaitable<U>;
}

export interface RestateLib {
  /**
   * Race awaitables, journaling the winner. This is the driver's only
   * asynchronous suspension point when more than one source is pending.
   */
  race<T>(items: readonly Awaitable<T>[]): Awaitable<T>;

  /**
   * True when the rejection is invocation cancellation (Restate's
   * `CancelledError`, a terminal error with code 409) rather than the failure
   * of the awaited work itself.
   */
  isCancellation(e: unknown): boolean;

  /**
   * True when the rejection means "this attempt is over, the invocation
   * continues later". Suspension must never be turned into an interrupt: no
   * finalizers may run, because the handler will be replayed.
   */
  isSuspension(e: unknown): boolean;
}

/** A settled source outcome. */
export type Settled =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

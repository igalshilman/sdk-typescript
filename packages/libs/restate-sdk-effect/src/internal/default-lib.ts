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

// Production wiring of the journal seam: `RestatePromise`.
//
// `RestatePromise` already satisfies `Awaitable<T>` structurally (it is a
// thenable with the same `.map((v, e) => U)` shape), so the adapter is a cast
// at the boundary.

import * as restate from "@restatedev/restate-sdk";
import type { Awaitable, RestateLib } from "./lib.js";

export const defaultLib: RestateLib = {
  race<T>(items: readonly Awaitable<T>[]): Awaitable<T> {
    return restate.RestatePromise.race(
      items as unknown as readonly restate.RestatePromise<T>[]
    ) as unknown as Awaitable<T>;
  },
  // Cancellation is delivered by the SDK as a rejection of whatever promise is
  // currently being awaited (each `RestatePromise` races an internal cancel
  // promise), so it can arrive on the aggregate race or on a lone source.
  isCancellation(e: unknown): boolean {
    return e instanceof restate.CancelledError;
  },
  isSuspension(e: unknown): boolean {
    return restate.internal.isSuspendedError(e);
  },
};

/** Adapt an SDK promise to the driver's seam type. */
export function adapt<T>(p: restate.RestatePromise<T>): Awaitable<T> {
  return p as unknown as Awaitable<T>;
}

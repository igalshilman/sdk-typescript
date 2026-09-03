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

// Stand-ins for real I/O. Everything here is the kind of code that belongs
// inside a `restate.activity`: it touches the outside world, takes real time,
// and sometimes fails.

import { Effect } from "effect";

const wait = (millis: number) =>
  new Promise<void>((r) => setTimeout(r, millis));

export const chargeCard = (orderId: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    await wait(30);
    return `receipt-${orderId}`;
  });

export const refundCard = (receipt: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    await wait(10);
    return `refunded-${receipt}`;
  });

export const reserveStock = (item: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    await wait(50);
    return `reserved-${item}`;
  });

export const releaseStock = (reservation: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    await wait(10);
    return `released-${reservation}`;
  });

/** Fails the first `failures` times it is called, then succeeds. */
export const flaky = (
  label: string,
  failures: number
): Effect.Effect<string, Error> => {
  let attempts = 0;
  return Effect.suspend(() => {
    attempts += 1;
    return attempts <= failures
      ? Effect.fail(new Error(`${label} failed on attempt ${attempts}`))
      : Effect.succeed(`${label} succeeded on attempt ${attempts}`);
  });
};

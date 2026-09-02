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

// Deliberately nondeterministic handlers: each attempt takes a different branch,
// so the journal must not match on replay. The point is that Restate's
// journal-mismatch detection still fires through this SDK's runtime.

import { Effect } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { counterObject } from "./counter.js";

const invokeCounts = new Map<string, number>();

function doLeftAction(k: string): boolean {
  const next = (invokeCounts.get(k) ?? 0) + 1;
  invokeCounts.set(k, next);
  return next % 2 === 1;
}

const finish = Effect.gen(function* () {
  const key = yield* restate.key;
  yield* Effect.sleep("100 millis");
  yield* restate.sendClient(counterObject, key).add(1);
});

export const nonDeterministic = restate.object({
  name: "NonDeterministic",
  handlers: {
    setDifferentKey: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        if (doLeftAction(key)) {
          yield* restate.state.set("a", "my-state");
        } else {
          yield* restate.state.set("b", "my-state");
        }
        yield* finish;
      })
    ),

    backgroundInvokeWithDifferentTargets: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        if (doLeftAction(key)) {
          yield* restate.sendClient(counterObject, "abc").get();
        } else {
          yield* restate.sendClient(counterObject, "abc").reset();
        }
        yield* finish;
      })
    ),

    callDifferentMethod: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        if (doLeftAction(key)) {
          yield* restate.client(counterObject, "abc").get();
        } else {
          yield* restate.client(counterObject, "abc").reset();
        }
        yield* finish;
      })
    ),

    eitherSleepOrCall: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        if (doLeftAction(key)) {
          yield* Effect.sleep("100 millis");
        } else {
          yield* restate.client(counterObject, "abc").get();
        }
        yield* finish;
      })
    ),
  },
});

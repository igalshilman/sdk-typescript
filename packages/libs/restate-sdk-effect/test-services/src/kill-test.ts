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

import { Effect } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { awakeableHolder } from "./awakeable-holder.js";

export const killTestSingleton = restate.object({
  name: "KillTestSingleton",
  handlers: {
    // A recursive call chain, each level parked on an awakeable. Killing the
    // top of the tree must tear the whole chain down.
    recursiveCall: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        const callback = yield* restate.awakeable();
        yield* restate.sendClient(awakeableHolder, key).hold(callback.id);
        yield* callback.result;
        yield* restate.call<void, void>({
          service: "KillTestSingleton",
          method: "recursiveCall",
          key,
          parameter: undefined,
        });
      })
    ),

    isUnlocked: restate.handler({}, () => Effect.void),
  },
});

export const killTestRunner = restate.object({
  name: "KillTestRunner",
  handlers: {
    startCallTree: restate.handler({}, () =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        yield* restate.client(killTestSingleton, key).recursiveCall();
      })
    ),
  },
});

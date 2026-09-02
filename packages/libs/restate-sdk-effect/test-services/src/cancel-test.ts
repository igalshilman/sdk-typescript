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

// The cancellation conformance shape. Note what the runner does: it catches the
// *callee's* failure (a cancelled call reports code 409 to its caller), which is
// an ordinary catchable failure here. Self-cancellation, by contrast, interrupts
// the handler — see SHARP-EDGES.md.

import { Effect } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { awakeableHolder } from "./awakeable-holder.js";

export const cancelTestRunner = restate.object({
  name: "CancelTestRunner",
  handlers: {
    startTest: restate.handler({}, (op: string) =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        yield* restate.rpc
          .call<string, void>({
            service: "CancelTestBlockingService",
            method: "block",
            key,
            parameter: op,
          })
          .pipe(
            Effect.catchTag("RestateFailure", (failure) =>
              failure.code === 409
                ? restate.state.set("state", true)
                : Effect.fail(failure)
            )
          );
      })
    ),

    verifyTest: restate.sharedHandler({}, () =>
      Effect.map(restate.state.get<boolean>("state"), (v) => v === true)
    ),
  },
});

export const cancelTestBlockingService = restate.object({
  name: "CancelTestBlockingService",
  handlers: {
    block: restate.handler({}, (op: string) =>
      Effect.gen(function* () {
        const key = yield* restate.key;
        const callback = yield* restate.awakeable();
        yield* restate.client(awakeableHolder, key).hold(callback.id);
        yield* callback.result;

        switch (op) {
          case "CALL":
            yield* restate.rpc.call<string, void>({
              service: "CancelTestBlockingService",
              method: "block",
              key,
              parameter: op,
            });
            break;
          case "SLEEP":
            yield* Effect.sleep(`${1024 * 24 * 60 * 60 * 1000} millis`);
            break;
          case "AWAKEABLE": {
            const second = yield* restate.awakeable();
            yield* second.result;
            break;
          }
        }
      })
    ),

    isUnlocked: restate.handler({}, () => Effect.void),
  },
});

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

export const blockAndWaitWorkflow = restate.workflow({
  name: "BlockAndWaitWorkflow",
  handlers: {
    run: restate.handler({}, (input: string) =>
      Effect.gen(function* () {
        yield* restate.state.set("my-state", input);
        const output =
          yield* restate.workflowPromise<string>("durable-promise");
        const value = yield* output.result;
        const peeked = yield* output.peek;
        if (peeked === undefined || peeked === null) {
          return yield* restate.terminalError(
            "Durable promise should be completed"
          );
        }
        return value;
      })
    ),

    unblock: restate.handler({}, (output: string) =>
      Effect.gen(function* () {
        const promise =
          yield* restate.workflowPromise<string>("durable-promise");
        yield* promise.resolve(output);
      })
    ),

    getState: restate.handler({}, () =>
      Effect.map(restate.state.get<string>("my-state"), (v) => v ?? null)
    ),
  },
});

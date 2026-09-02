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

export const testUtilsService = restate.service({
  name: "TestUtilsService",
  handlers: {
    echo: restate.handler({}, (input: string) => Effect.succeed(input)),

    uppercaseEcho: restate.handler({}, (input: string) =>
      Effect.succeed(input.toUpperCase())
    ),

    echoHeaders: restate.handler({}, () =>
      Effect.map(restate.handlerRequest, (request) => {
        const out: Record<string, string> = {};
        for (const [k, v] of request.headers) out[k] = v;
        return out;
      })
    ),

    rawEcho: restate.handler(
      { input: restate.serde.binary, output: restate.serde.binary },
      (input: Uint8Array) => Effect.succeed(input)
    ),

    // Counts how many times the `run` closures actually executed: on a replay
    // the recorded results are served and the closures do not run.
    countExecutedSideEffects: restate.handler({}, (increments: number) =>
      Effect.gen(function* () {
        let invokedSideEffects = 0;
        for (let i = 0; i < increments; i++) {
          yield* restate.run(
            "count",
            Effect.sync(() => {
              invokedSideEffects += 1;
            })
          );
        }
        return invokedSideEffects;
      })
    ),

    cancelInvocation: restate.handler({}, (invocationId: string) =>
      restate.cancel(invocationId as never)
    ),

    resolveSignal: restate.handler(
      {},
      (req: { invocationId: string; signalName: string; value: string }) =>
        restate
          .invocation(req.invocationId)
          .signal<string>(req.signalName)
          .resolve(req.value)
    ),

    rejectSignal: restate.handler(
      {},
      (req: { invocationId: string; signalName: string; reason: string }) =>
        restate
          .invocation(req.invocationId)
          .signal(req.signalName)
          .reject(req.reason)
    ),
  },
});

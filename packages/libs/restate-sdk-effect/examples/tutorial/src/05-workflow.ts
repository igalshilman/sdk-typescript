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

// Tier 5: a workflow that waits for a human, with a deadline. Shows a durable
// promise (addressable from the workflow's other handlers), an awakeable
// (addressable by anyone holding its id), and a background fiber.
//
//   curl localhost:8080/approval/req-1/run     --json '{"amount":900}'
//   curl localhost:8080/approval/req-1/decide  --json 'true'
//   curl localhost:8080/approval/req-1/status  --json 'null'

import { Effect, Queue, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

const Request = Schema.Struct({ amount: Schema.Number });

export const approval = restate.workflow({
  name: "approval",
  handlers: {
    run: restate.handler({ input: Request, output: Schema.String }, (request) =>
      Effect.gen(function* () {
        yield* restate.state.set("status", Schema.String, "awaiting-decision");

        // A background fiber reporting progress. It is interrupted (and
        // finalized) before the invocation completes.
        const events = yield* Queue.make<string>();
        yield* Effect.forkChild(
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              yield* Effect.logInfo(`progress: ${event}`);
            }
          })
        );
        yield* Queue.offer(events, "started");

        const decision = yield* restate.workflowPromise(
          "decision",
          Schema.Boolean
        );

        // Wait for a human, but not forever: a durable timeout.
        const outcome = yield* decision.result.pipe(
          Effect.timeout("7 days"),
          Effect.match({
            onFailure: () => "expired",
            onSuccess: (approved) => (approved ? "approved" : "rejected"),
          })
        );

        yield* restate.state.set("status", Schema.String, outcome);
        return `${request.amount}: ${outcome}`;
      })
    ),

    decide: restate.handler(
      { input: Schema.Boolean, output: Schema.Void },
      (approved) =>
        Effect.gen(function* () {
          const decision = yield* restate.workflowPromise(
            "decision",
            Schema.Boolean
          );
          yield* decision.resolve(approved);
        })
    ),

    status: restate.handler({ input: Schema.Void, output: Schema.String }, () =>
      Effect.map(
        restate.state.get("status", Schema.String),
        (status) => status ?? "unknown"
      )
    ),
  },
});

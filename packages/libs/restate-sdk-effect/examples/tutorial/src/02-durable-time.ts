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

// Tier 2: time. `Effect.sleep`, `Effect.timeout` and `Effect.retry` are durable
// here, because the invocation's Clock is journaled — a sleeping invocation
// suspends, and the process may exit while it waits.
//
//   curl localhost:8080/time/reminder   --json '"take a break"'
//   curl localhost:8080/time/withDeadline --json '"o-9"'
//   curl localhost:8080/time/withRetry  --json 'null'

import { Effect, Schedule, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { chargeCard, flaky } from "./fakes.js";

const unreliable = flaky("payment-gateway", 2);

export const time = restate.service({
  name: "time",
  handlers: {
    // The invocation suspends for a day and resumes on the other side.
    reminder: restate.handler(
      { input: Schema.String, output: Schema.String },
      (message) =>
        Effect.gen(function* () {
          yield* Effect.sleep("24 hours");
          return yield* restate.run("send", Effect.succeed(`sent: ${message}`));
        })
    ),

    // A durable timeout: the timer is journaled, so it survives a restart.
    withDeadline: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        restate.run("charge", chargeCard(orderId)).pipe(
          Effect.timeout("5 seconds"),
          Effect.match({
            onFailure: () => "payment timed out",
            onSuccess: (receipt) => receipt,
          })
        )
    ),

    // Domain-level retry: each attempt is a fresh journaled step and each
    // backoff a durable timer, so the invocation can resume mid-backoff.
    // (Restate's own per-step retries are a different layer — they cover
    // transient infrastructure failures inside one step.)
    withRetry: restate.handler(
      { input: Schema.Void, output: Schema.String },
      () =>
        restate.run("call-gateway", Effect.orDie(unreliable)).pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 4,
          }),
          Effect.catchTag("RestateFailure", (failure) =>
            Effect.succeed(`gave up: ${failure.message}`)
          )
        )
    ),
  },
});

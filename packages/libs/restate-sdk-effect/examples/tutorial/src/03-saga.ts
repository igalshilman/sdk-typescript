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

// Tier 3: sagas. Two shapes — explicit `Effect.exit` + compensation, and
// `acquireRelease`, whose finalizers also run when the invocation is cancelled.
//
//   curl localhost:8080/saga/process     --json '{"orderId":"o-1","fail":false}'
//   curl localhost:8080/saga/process     --json '{"orderId":"o-2","fail":true}'
//   curl localhost:8080/saga/scoped      --json '"o-3"'

import { Effect, Exit, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { chargeCard, refundCard, releaseStock, reserveStock } from "./fakes.js";

const Order = Schema.Struct({
  orderId: Schema.String,
  fail: Schema.Boolean,
});

class CardDeclined extends Schema.TaggedError<CardDeclined>()(
  "CardDeclined",
  {}
) {}

export const saga = restate.service({
  name: "saga",
  handlers: {
    // Observe each step's outcome and compensate the ones that succeeded.
    process: restate.handler({ input: Order, output: Schema.String }, (order) =>
      Effect.gen(function* () {
        const reservation = yield* reserveStock(order.orderId).pipe(
          restate.activity("reserve", { result: Schema.String })
        );

        // `Effect.exit` turns the step's outcome into a value, so a failure
        // becomes something to branch on rather than something to propagate.
        const charged = yield* Effect.exit(
          (order.fail
            ? Effect.fail(new CardDeclined())
            : chargeCard(order.orderId)
          ).pipe(
            restate.activity("charge", {
              result: Schema.String,
              error: CardDeclined,
            })
          )
        );

        if (Exit.isFailure(charged)) {
          const released = yield* releaseStock(reservation).pipe(
            restate.activity("release", { result: Schema.String })
          );
          return `compensated: ${released}`;
        }
        return `ok: ${charged.value}`;
      })
    ),

    // The same thing with scopes: the release runs on *any* exit — success,
    // failure, or the invocation being cancelled.
    scoped: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        Effect.gen(function* () {
          const receipt = yield* Effect.acquireRelease(
            chargeCard(orderId).pipe(
              restate.activity("charge", { result: Schema.String })
            ),
            (receipt, exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : // A finalizer cannot fail: a failing refund is a defect, and
                  // Restate retries the attempt.
                  Effect.asVoid(
                    Effect.orDie(
                      refundCard(receipt).pipe(
                        restate.activity("refund", { result: Schema.String })
                      )
                    )
                  )
          );
          const reservation = yield* reserveStock(orderId).pipe(
            restate.activity("reserve", { result: Schema.String })
          );
          return `${receipt} / ${reservation}`;
        }).pipe(Effect.scoped)
    ),
  },
});

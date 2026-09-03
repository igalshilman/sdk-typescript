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

// Tier 1: external activities, and concurrency over them.
//
//   curl localhost:8080/basics/hello      --json '"world"'
//   curl localhost:8080/basics/sequential --json '"o-1"'
//   curl localhost:8080/basics/parallel   --json '"o-2"'
//   curl localhost:8080/basics/first      --json '"o-3"'
//   curl localhost:8080/basics/fanOut     --json '["a","b","c","d","e"]'

import { Effect, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
import { chargeCard, reserveStock } from "./fakes.js";

export const basics = restate.service({
  name: "basics",
  handlers: {
    // Pure deterministic effects need no Restate wrapper.
    hello: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) => Effect.succeed(`Hello, ${name}!`)
    ),

    // Two entries, in source order.
    sequential: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        Effect.gen(function* () {
          const reservation = yield* reserveStock(orderId).pipe(
            restate.activity("reserve", { result: Schema.String })
          );
          const receipt = yield* chargeCard(orderId).pipe(
            restate.activity("charge", { result: Schema.String })
          );
          return `${reservation} / ${receipt}`;
        })
    ),

    // Both steps run concurrently. Which one finishes first is decided by the
    // journal, not by the clock, so a replay sees the same interleaving.
    parallel: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        Effect.map(
          Effect.all(
            [
              reserveStock(orderId).pipe(
                restate.activity("reserve", { result: Schema.String })
              ),
              chargeCard(orderId).pipe(
                restate.activity("charge", { result: Schema.String })
              ),
            ],
            { concurrency: "unbounded" }
          ),
          ([reservation, receipt]) => `${reservation} + ${receipt}`
        )
    ),

    // The loser is interrupted; its finalizers run.
    first: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        Effect.race(
          chargeCard(orderId).pipe(
            restate.activity("charge", { result: Schema.String })
          ),
          reserveStock(orderId).pipe(
            restate.activity("reserve", { result: Schema.String })
          )
        )
    ),

    // Bounded fan-out: at most three steps in flight at a time.
    fanOut: restate.handler(
      {
        input: Schema.Array(Schema.String),
        output: Schema.Array(Schema.String),
      },
      (items) =>
        Effect.forEach(
          items,
          (item, i) =>
            reserveStock(item).pipe(
              restate.activity(`item-${i}`, { result: Schema.String })
            ),
          {
            concurrency: 3,
          }
        )
    ),
  },
});

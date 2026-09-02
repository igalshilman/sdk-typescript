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

// Tier 1: journaled steps, and concurrency over them.
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
    // One journal entry. The closure runs on the first execution; every
    // replay serves the recorded value without re-running it.
    hello: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) => restate.run("compose", Effect.succeed(`Hello, ${name}!`))
    ),

    // Two entries, in source order.
    sequential: restate.handler(
      { input: Schema.String, output: Schema.String },
      (orderId) =>
        Effect.gen(function* () {
          const reservation = yield* restate.run(
            "reserve",
            reserveStock(orderId)
          );
          const receipt = yield* restate.run("charge", chargeCard(orderId));
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
              restate.run("reserve", reserveStock(orderId)),
              restate.run("charge", chargeCard(orderId)),
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
          restate.run("charge", chargeCard(orderId)),
          restate.run("reserve", reserveStock(orderId))
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
          (item, i) => restate.run(`item-${i}`, reserveStock(item)),
          {
            concurrency: 3,
          }
        )
    ),
  },
});

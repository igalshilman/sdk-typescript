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

// Tier 6: application services. One `Layer`, built once per process; the
// handlers name what they need and `serve` checks the layer provides it.
//
//   curl localhost:8080/users/lookup --json '"u-1"'

import { Context, Effect, Layer, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

/** A pretend database connection pool. */
export interface Db {
  readonly lookup: (id: string) => Promise<string>;
}
export const Db = Context.Service<Db>("Db");

/** Built once, at endpoint start; shared by every invocation. */
export const DbLayer: Layer.Layer<Db> = Layer.succeed(Db, {
  lookup: (id) => Promise.resolve(`user(${id})`),
});

class UnknownUser extends Schema.TaggedError<UnknownUser>()("UnknownUser", {
  id: Schema.String,
}) {}

export const users = restate.service({
  name: "users",
  handlers: {
    lookup: restate.handler(
      { input: Schema.String, output: Schema.String, error: UnknownUser },
      (id) =>
        Effect.gen(function* () {
          if (id === "") return yield* new UnknownUser({ id });
          const db = yield* Db;
          // The activity runs on the application runtime: real clock, real I/O.
          return yield* Effect.promise(() => db.lookup(id)).pipe(
            restate.activity("lookup", { result: Schema.String })
          );
        })
    ),
  },
});

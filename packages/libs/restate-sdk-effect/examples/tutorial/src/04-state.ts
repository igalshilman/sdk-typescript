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

// Tier 4: a virtual object — state, keyed by the object's id.
//
//   curl localhost:8080/cart/alice/add    --json '{"sku":"book","price":12}'
//   curl localhost:8080/cart/alice/total  --json 'null'
//   curl localhost:8080/cart/alice/items  --json 'null'
//   curl localhost:8080/cart/alice/clear  --json 'null'

import { Effect, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

const Item = Schema.Struct({ sku: Schema.String, price: Schema.Number });
const Items = Schema.Array(Item);

export const cart = restate.object({
  name: "cart",
  handlers: {
    // Exclusive handlers run one at a time per key, and may write state.
    add: restate.handler({ input: Item, output: Schema.Number }, (item) =>
      Effect.gen(function* () {
        const items = (yield* restate.state.get("items", Items)) ?? [];
        const next = [...items, item];
        yield* restate.state.set("items", Items, next);
        return next.length;
      })
    ),

    clear: restate.handler({ input: Schema.Void, output: Schema.Void }, () =>
      restate.state.clear("items")
    ),

    // Shared handlers run concurrently with the exclusive ones, so they may
    // read state but not write it — `restate.state.set` here would not compile.
    total: restate.sharedHandler(
      { input: Schema.Void, output: Schema.Number },
      () =>
        Effect.map(restate.state.get("items", Items), (items) =>
          (items ?? []).reduce((sum, item) => sum + item.price, 0)
        )
    ),

    items: restate.sharedHandler({ input: Schema.Void, output: Items }, () =>
      Effect.map(restate.state.get("items", Items), (items) => items ?? [])
    ),

    whoAmI: restate.sharedHandler(
      { input: Schema.Void, output: Schema.String },
      () => restate.key
    ),
  },
});

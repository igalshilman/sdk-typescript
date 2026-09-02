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

export const listObject = restate.object({
  name: "ListObject",
  handlers: {
    append: restate.handler({}, (value: string) =>
      Effect.gen(function* () {
        const list = (yield* restate.state.get<string[]>("list")) ?? [];
        yield* restate.state.set("list", [...list, value]);
      })
    ),

    get: restate.sharedHandler({}, () =>
      Effect.map(restate.state.get<string[]>("list"), (list) => list ?? [])
    ),

    clear: restate.handler({}, () =>
      Effect.gen(function* () {
        const list = (yield* restate.state.get<string[]>("list")) ?? [];
        yield* restate.state.clear("list");
        return list;
      })
    ),
  },
});

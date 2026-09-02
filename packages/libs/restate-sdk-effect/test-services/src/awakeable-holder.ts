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

export const awakeableHolder = restate.object({
  name: "AwakeableHolder",
  handlers: {
    hold: restate.handler({}, (id: string) => restate.state.set("id", id)),

    hasAwakeable: restate.sharedHandler({}, () =>
      Effect.map(restate.state.get<string>("id"), (id) => id != null)
    ),

    unlock: restate.handler({}, (payload: string) =>
      Effect.gen(function* () {
        const id = yield* restate.state.get<string>("id");
        if (id == null) {
          return yield* restate.terminalError("No awakeable is registered");
        }
        yield* restate.resolveAwakeable(id, payload);
      })
    ),
  },
});

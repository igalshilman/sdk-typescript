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

type Entry = { key: string; value: string };

export const mapObject = restate.object({
  name: "MapObject",
  handlers: {
    set: restate.handler({}, (entry: Entry) =>
      restate.state.set(entry.key, entry.value)
    ),

    get: restate.sharedHandler({}, (k: string) =>
      Effect.map(restate.state.get<string>(k), (v) => v ?? "")
    ),

    clearAll: restate.handler({}, () =>
      Effect.gen(function* () {
        const keys = yield* restate.state.keys();
        const entries: Entry[] = [];
        for (const k of keys) {
          const value = (yield* restate.state.get<string>(k)) ?? "";
          entries.push({ key: k, value });
          yield* restate.state.clear(k);
        }
        return entries;
      })
    ),
  },
});

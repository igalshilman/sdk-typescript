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

export const counterObject = restate.object({
  name: "Counter",
  handlers: {
    reset: restate.handler({}, () => restate.state.clear("counter")),

    get: restate.sharedHandler({}, () =>
      Effect.map(restate.state.get<number>("counter"), (v) => v ?? 0)
    ),

    add: restate.handler({}, (addend: number) =>
      Effect.gen(function* () {
        const oldValue = (yield* restate.state.get<number>("counter")) ?? 0;
        const newValue = oldValue + addend;
        yield* restate.state.set("counter", newValue);
        return { oldValue, newValue };
      })
    ),

    addThenFail: restate.handler({}, (addend: number) =>
      Effect.gen(function* () {
        const oldValue = (yield* restate.state.get<number>("counter")) ?? 0;
        yield* restate.state.set("counter", oldValue + addend);
        const key = yield* restate.key;
        return yield* restate.terminalError(key);
      })
    ),
  },
});

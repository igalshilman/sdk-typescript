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

// Definition-site rules, all three of which used to compile silently.
//
//  1. A handler whose effect can fail with a *domain* error must declare a
//     codec for it. Without one the failure was treated as a defect and the
//     attempt retried — safe, and almost never what was meant.
//  2. `sharedHandler` is meaningless in a plain service.
//  3. A workflow's `run` handler is exclusive by definition.
//
// `RestateFailure` is exempt from (1): every durable operation can produce one
// and the boundary propagates it terminally by itself.

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import * as restate from "../src/index.js";

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  item: Schema.String,
}) {}

describe("a fallible handler must declare its error codec", () => {
  it("accepts a declared domain error", () => {
    const h = restate.handler(
      { input: Schema.String, output: Schema.String, error: OutOfStock },
      (item: string) =>
        item === "unicorn"
          ? Effect.fail(new OutOfStock({ item }))
          : Effect.succeed(item)
    );
    expect(h._effectHandler.shared).toBe(false);
  });

  it("accepts an undeclared RestateFailure, which needs no codec", () => {
    // Every durable operation can fail this way; requiring a codec for it
    // would mean declaring one on nearly every handler.
    const h = restate.handler(
      { input: Schema.String, output: Schema.String },
      (name: string) => restate.run("upper", Effect.succeed(name.toUpperCase()))
    );
    expect(h._effectHandler.shared).toBe(false);
  });

  it("rejects an undeclared domain error", () => {
    const bad = () =>
      // @ts-expect-error — `OutOfStock` needs an `error:` codec.
      restate.handler(
        { input: Schema.String, output: Schema.String },
        (item: string) => Effect.fail(new OutOfStock({ item }))
      );
    void bad;
  });

  it("accepts an undeclared failure once it is turned into a defect", () => {
    // The escape hatch: `orDie` says "this is a bug, retry the attempt".
    const h = restate.handler(
      { input: Schema.String, output: Schema.String },
      (item: string) =>
        Effect.orDie(
          item === "unicorn"
            ? Effect.fail(new OutOfStock({ item }))
            : Effect.succeed(item)
        )
    );
    expect(h._effectHandler.shared).toBe(false);
  });
});

describe("handler placement", () => {
  const exclusive = restate.handler({ output: Schema.String }, () =>
    Effect.succeed("x")
  );
  const shared = restate.sharedHandler({ output: Schema.String }, () =>
    Effect.succeed("x")
  );

  it("rejects a shared handler in a plain service", () => {
    const bad = () =>
      restate.service({
        name: "s",
        // @ts-expect-error — a service has nothing to share against.
        handlers: { peek: shared },
      });
    void bad;
  });

  it("accepts shared handlers in a virtual object", () => {
    const cart = restate.object({
      name: "cart",
      handlers: { add: exclusive, total: shared },
    });
    expect(cart._handlers.total._shared).toBe(true);
  });

  it("rejects a shared workflow `run`", () => {
    const bad = () =>
      restate.workflow({
        name: "w",
        // @ts-expect-error — `run` is the workflow's exclusive execution.
        handlers: { run: shared },
      });
    void bad;
  });

  it("accepts an exclusive `run` beside shared workflow handlers", () => {
    const order = restate.workflow({
      name: "order",
      handlers: { run: exclusive, status: shared },
    });
    expect(order._handlers.run._shared).toBe(false);
    expect(order._handlers.status._shared).toBe(true);
  });
});

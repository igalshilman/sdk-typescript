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

// Pre-release ergonomics: schema-bound state cells, and Schema-based contract
// declaration. Both remove a declaration that was previously repeated.

import { describe, expect, it } from "vitest";
import { Context, Effect, Schema } from "effect";
import * as restate from "../src/index.js";
import { Driver } from "../src/internal.js";
import { FakeJournal } from "./harness.js";

/** Exact type equality, including union order-insensitivity. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertType = <T extends true>(): void => {
  void 0 as unknown as T;
};

describe("state cells", () => {
  it("binds a key to its codec once", () => {
    const count = restate.state("count", Schema.Number);
    // The codec is bound, so the value type follows from it.
    assertType<Equals<Effect.Success<typeof count.get>, number | null>>();
    expect(typeof count.set).toBe("function");
  });

  it("reads, writes and clears through the bound key", async () => {
    // Driven against the fake journal: what matters is that the cell issues
    // the same operations the ad-hoc form does, under the bound name.
    const journal = new FakeJournal();
    const driver = new Driver(journal);
    const ops: string[] = [];
    const recording = {
      abortSignal: driver.abortSignal,
      enterJournalOp: (op: string) => ops.push(op),
      park: driver.park.bind(driver),
    };
    const invocation = {
      ctx: {
        get: () => journal.entry("state.get"),
        set: () => undefined,
        clear: () => undefined,
      },
      kind: "object" as const,
      driver: recording,
      appContext: Context.empty(),
      attemptStartMillis: 0,
    };
    const context = Context.add(
      Context.empty(),
      restate.RestateContext,
      invocation as unknown as restate.RestateInvocation
    );

    const count = restate.state("count", Schema.Number);
    const program = Effect.gen(function* () {
      yield* count.set(7);
      yield* count.clear;
    }) as Effect.Effect<void, never, never>;
    await driver.run(program, context as Context.Context<never>);

    expect(ops).toEqual(["state.set(count)", "state.clear(count)"]);
  });

  it("keeps the ad-hoc operations alongside", () => {
    // `state` is still the object it was; the cell is an addition.
    expect(typeof restate.state.get).toBe("function");
    expect(typeof restate.state.keys).toBe("function");
    expect(typeof restate.state.clearAll).toBe("function");
  });
});

describe("iface.schema", () => {
  it("declares a contract from Effect Schemas", () => {
    const Greeter = restate.iface.service("greeter", {
      greet: restate.iface.schema({
        input: Schema.String,
        output: Schema.String,
      }),
      peek: restate.iface.shared.schema({ output: Schema.Number }),
    });
    expect(Greeter.name).toBe("greeter");
    expect(Greeter._handlers.greet._inputSerde).toBeDefined();
    expect(Greeter._handlers.peek._shared).toBe(true);
  });

  it("types the contract from the schemas, so clients are typed", () => {
    const Greeter = restate.iface.service("greeter", {
      greet: restate.iface.schema({
        input: Schema.String,
        output: Schema.Number,
      }),
    });
    const client = restate.client(Greeter);
    assertType<
      Equals<Effect.Success<ReturnType<typeof client.greet>>, number>
    >();
    // @ts-expect-error — the contract says the input is a string.
    const bad = () => client.greet(42);
    void bad;
  });

  it("still exposes core's json/serdes declarators", () => {
    expect(typeof restate.iface.json).toBe("function");
    expect(typeof restate.iface.serdes).toBe("function");
    expect(typeof restate.iface.shared.json).toBe("function");
  });
});

describe("runExit is gone", () => {
  it("is not exported — Effect.exit(run(...)) says it", () => {
    expect("runExit" in restate).toBe(false);
  });
});

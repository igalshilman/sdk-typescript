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

// Contract enforcement, at the type level.
//
// Two rules this file exists to keep:
//
//  1. `implement` must satisfy the descriptor. A contract you can "implement"
//     with nothing is not a contract.
//  2. A client call's first argument is the *input*, never the options. For a
//     void-input handler that means `ping(opts)` is a compile error, because at
//     runtime position 0 is parsed as the request body — a legitimate body can
//     look exactly like `CallOptions`, so the runtime cannot tell them apart
//     and must not try.
//
// Both are `@ts-expect-error` assertions: the test passes only while the
// offending call is still rejected.

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import * as restate from "../src/index.js";

const contract = restate.iface.service("greeter", {
  greet: restate.iface.json<string, string>(),
  ping: restate.iface.json<void, string>(),
});

const greet = restate.handler(
  { input: Schema.String, output: Schema.String },
  (name: string) => Effect.succeed(`hello ${name}`)
);
const ping = restate.handler({ output: Schema.String }, () =>
  Effect.succeed("pong")
);

describe("implement is bound by the descriptor", () => {
  it("accepts an implementation of every declared handler", () => {
    const impl = restate.implement(contract, { greet, ping });
    expect(impl.name).toBe("greeter");
    expect(Object.keys(impl._handlers).sort()).toEqual(["greet", "ping"]);
  });

  it("rejects an empty implementation", () => {
    // @ts-expect-error — `greet` and `ping` are missing.
    const bad = () => restate.implement(contract, {});
    void bad;
  });

  it("rejects a partial implementation", () => {
    // @ts-expect-error — `ping` is missing.
    const bad = () => restate.implement(contract, { greet });
    void bad;
  });

  it("rejects a handler whose input does not match the contract", () => {
    const wrongInput = restate.handler(
      { input: Schema.Number, output: Schema.String },
      (n: number) => Effect.succeed(String(n))
    );
    // @ts-expect-error — the contract declares `greet` as string -> string.
    const bad = () => restate.implement(contract, { greet: wrongInput, ping });
    void bad;
  });
});

describe("client calls are positional", () => {
  it("takes options in second position for a void-input handler", () => {
    const client = restate.client(contract);
    // Both legal forms compile.
    void client.ping();
    void client.ping(undefined, { idempotencyKey: "k" });
    void restate.sendClient(contract).ping(undefined, { delay: 10 });
    expect(typeof client.ping).toBe("function");
  });

  it("rejects options in first position for a void-input handler", () => {
    const client = restate.client(contract);
    // @ts-expect-error — position 0 is the input; this would be sent as the body.
    const bad = () => client.ping({ idempotencyKey: "k" });
    void bad;
  });

  it("rejects options in first position on a send client too", () => {
    const client = restate.sendClient(contract);
    // @ts-expect-error — same rule for sends.
    const bad = () => client.ping({ delay: 10 });
    void bad;
  });

  it("still takes the input first for a non-void handler", () => {
    const client = restate.client(contract);
    void client.greet("world");
    void client.greet("world", { idempotencyKey: "k" });
    // @ts-expect-error — the input is required.
    const bad = () => client.greet({ idempotencyKey: "k" });
    void bad;
  });
});

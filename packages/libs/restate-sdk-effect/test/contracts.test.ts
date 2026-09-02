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
//  2. Client options are the SDK's branded `rpc.opts` / `rpc.sendOpts`. The
//     brand is what disambiguates a lone argument: a plain object is a request
//     body, even one that happens to have an `idempotencyKey` field, so an
//     unbranded options object must not type-check. `rpc.opts` and
//     `rpc.sendOpts` are separately branded, so a send's `delay` cannot reach a
//     request-response call either.
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

describe("implement accepts bare effect functions", () => {
  it("takes a plain function per slot, inheriting the contract's codecs", () => {
    const impl = restate.implement(contract, {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      ping: () => Effect.succeed("pong"),
    });
    expect(impl.name).toBe("greeter");
    // The contract's serdes are what the definition advertises.
    expect(impl._handlers.greet._inputSerde).toBe(
      contract._handlers.greet._inputSerde
    );
  });

  it("mixes bare functions with explicit handlers in one call", () => {
    const impl = restate.implement(contract, {
      // `handler` still earns its place: discovery options, error codecs.
      greet: restate.handler(
        { description: "greets", output: Schema.String },
        (name: string) => Effect.succeed(`hello ${name}`)
      ),
      ping: () => Effect.succeed("pong"),
    });
    expect(Object.keys(impl._handlers).sort()).toEqual(["greet", "ping"]);
  });

  it("takes sharedness from the contract, not from the implementation", () => {
    const objectContract = restate.iface.object("cart", {
      total: restate.iface.shared.json<void, number>(),
      add: restate.iface.json<string, void>(),
    });
    // A plain `handler` in a shared slot is accepted: the descriptor already
    // says the slot is shared, so repeating it with `sharedHandler` is noise.
    const impl = restate.implement(objectContract, {
      total: () =>
        restate.state
          .get("total", Schema.Number)
          .pipe(Effect.map((v) => v ?? 0)),
      add: (item: string) =>
        Effect.gen(function* () {
          const current = yield* restate.state.get("total", Schema.Number);
          yield* restate.state.set("total", Schema.Number, (current ?? 0) + 1);
          void item;
        }),
    });
    expect(impl._handlers.total._shared).toBe(true);
    expect(impl._handlers.add._shared).toBe(false);
  });

  it("still rejects a bare function whose type does not match the slot", () => {
    const bad = () =>
      restate.implement(contract, {
        // @ts-expect-error — `greet` is string -> string, not number -> string.
        greet: (n: number) => Effect.succeed(String(n)),
        ping: () => Effect.succeed("pong"),
      });
    void bad;
  });
});

describe("client options are branded", () => {
  it("takes options in first position for a void-input handler", () => {
    const client = restate.client(contract);
    void client.ping();
    void client.ping(restate.rpc.opts({ idempotencyKey: "k" }));
    void restate.sendClient(contract).ping(restate.rpc.sendOpts({ delay: 10 }));
    expect(typeof client.ping).toBe("function");
  });

  it("takes input then options for a non-void handler", () => {
    const client = restate.client(contract);
    void client.greet("world");
    void client.greet("world", restate.rpc.opts({ idempotencyKey: "k" }));
    void restate
      .sendClient(contract)
      .greet("world", restate.rpc.sendOpts({ delay: 10 }));
    expect(typeof client.greet).toBe("function");
  });

  it("rejects an unbranded options object", () => {
    const client = restate.client(contract);
    // @ts-expect-error — a plain object is a request body, not options.
    const bad = () => client.ping({ idempotencyKey: "k" });
    void bad;
  });

  it("rejects send options on a request-response call", () => {
    const client = restate.client(contract);
    // @ts-expect-error — `SendOpts` is a different brand from `Opts`.
    const bad = () => client.ping(restate.rpc.sendOpts({ delay: 10 }));
    void bad;
  });

  it("rejects call options on a send", () => {
    const client = restate.sendClient(contract);
    // @ts-expect-error — and not the other way round either.
    const bad = () => client.ping(restate.rpc.opts({ idempotencyKey: "k" }));
    void bad;
  });

  it("still requires the input for a non-void handler", () => {
    const client = restate.client(contract);
    // @ts-expect-error — options cannot stand in for a required input.
    const bad = () => client.greet(restate.rpc.opts({ idempotencyKey: "k" }));
    void bad;
  });
});

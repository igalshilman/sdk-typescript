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

// Type-level tests for the capability markers (DESIGN §6.4, TODO S4-6).
//
// The assertions are checked by `tsc`: the test passes if this file compiles and
// every `@ts-expect-error` marks a real error. The `it` blocks exist so a
// failure names the property that broke.

import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import * as restate from "../src/index.js";

/** Exact type equality, including union order-insensitivity. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when `T` is exactly `true`. */
const assertType = <T extends true>(): void => {
  void 0 as unknown as T;
};

/** What a definition still needs from the application layer. */
type RequirementOf<D> = D extends { readonly _requires?: infer R }
  ? Exclude<R, undefined>
  : never;

/** The requirements of an effect. */
type ServicesOf<T> = Effect.Services<T>;

interface DbShape {
  readonly name: string;
}
const Db = Context.Service<DbShape>("Db");
const DbLayer = Layer.succeed(Db, { name: "db" });

describe("capability markers", () => {
  it("a service handler needs nothing beyond the invocation", () => {
    const greeter = restate.service({
      name: "greeter",
      handlers: {
        greet: restate.handler(
          { input: Schema.String, output: Schema.String },
          (name) => restate.run("upper", Effect.succeed(name.toUpperCase()))
        ),
      },
    });
    assertType<Equals<RequirementOf<typeof greeter>, never>>();
    // ...so it serves with no layer at all. (Never invoked: this is a
    // type-level assertion about the call, not a real endpoint.)
    const _serve = () => restate.serve({ services: [greeter] });
    expect(greeter.name).toBe("greeter");
    expect(typeof _serve).toBe("function");
  });

  it("an exclusive object handler may read and write state and read the key", () => {
    const counter = restate.object({
      name: "counter",
      handlers: {
        add: restate.handler({}, (n: number) =>
          Effect.gen(function* () {
            const current = (yield* restate.state.get<number>("c")) ?? 0;
            yield* restate.state.set("c", current + n);
            const key = yield* restate.key;
            return `${key}:${current + n}`;
          })
        ),
      },
    });
    assertType<Equals<RequirementOf<typeof counter>, never>>();
    expect(counter.name).toBe("counter");
  });

  it("a shared handler may read state", () => {
    const counter = restate.object({
      name: "counter-shared",
      handlers: {
        get: restate.sharedHandler({}, () => restate.state.get<number>("c")),
      },
    });
    assertType<Equals<RequirementOf<typeof counter>, never>>();
    expect(counter.name).toBe("counter-shared");
  });

  it("a shared handler that writes state leaves StateWrite unsatisfiable", () => {
    const bad = restate.object({
      name: "bad-shared",
      handlers: {
        write: restate.sharedHandler({}, () => restate.state.set("c", 1)),
      },
    });
    assertType<Equals<RequirementOf<typeof bad>, restate.StateWrite>>();
    // ...and no layer can provide it, so the definition cannot be served.
    const _serve = () =>
      // @ts-expect-error StateWrite is not provided by any layer
      restate.serve({ services: [bad], layer: Layer.empty });
    expect(typeof _serve).toBe("function");
  });

  it("workflow promises and keys are unavailable in a plain service", () => {
    const bad = restate.service({
      name: "bad-service",
      handlers: {
        promise: restate.handler({}, () =>
          Effect.asVoid(restate.workflowPromise<string>("p"))
        ),
      },
    });
    assertType<Equals<RequirementOf<typeof bad>, restate.DurablePromise>>();
    expect(bad.name).toBe("bad-service");
  });

  it("application services show up as the layer's requirement", () => {
    const svc = restate.service({
      name: "with-db",
      handlers: {
        use: restate.handler({}, () => Effect.map(Db, (db) => db.name)),
      },
    });
    assertType<Equals<RequirementOf<typeof svc>, DbShape>>();
    const _serve = () => restate.serve({ services: [svc], layer: DbLayer });
    expect(typeof _serve).toBe("function");
  });

  it("a run closure may not use Restate operations", () => {
    const poisoned = restate.run("bad", restate.state.set("k", 1));
    assertType<
      Equals<
        restate.RestateOperationsAreNotAllowedInsideRun extends ServicesOf<
          typeof poisoned
        >
          ? true
          : false,
        true
      >
    >();

    const fine = restate.run("ok", Effect.succeed(1));
    assertType<
      Equals<
        restate.RestateOperationsAreNotAllowedInsideRun extends ServicesOf<
          typeof fine
        >
          ? true
          : false,
        false
      >
    >();
    assertType<Equals<ServicesOf<typeof fine>, restate.RestateContext>>();
    expect(typeof poisoned).toBe("object");
  });
});

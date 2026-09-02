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

// The application runtime's lifecycle (DESIGN §3.3, TODO S1-8).
//
// A definition is built before the endpoint exists, so each one starts with its
// own empty slot. The *endpoint* owns the runtime: binding must build the layer
// once and share it, or a layer holding a connection pool would open one pool
// per service.

import { describe, expect, it } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import * as restate from "../src/index.js";
import type { AppRuntimeSlot } from "../src/internal.js";

/** The endpoint's binding hook, as the concrete slot it always is. */
const slotOf = (definition: {
  readonly _appRuntime: unknown;
}): AppRuntimeSlot => definition._appRuntime as AppRuntimeSlot;

interface PoolShape {
  readonly id: number;
}
const Pool = Context.Service<PoolShape>("test/Pool");

/** A layer that counts how many times it is built, and when it is released. */
function countingLayer() {
  const counts = { built: 0, released: 0 };
  const layer = Layer.effect(Pool)(
    Effect.acquireRelease(
      Effect.sync((): PoolShape => ({ id: ++counts.built })),
      () => Effect.sync(() => void counts.released++)
    )
  );
  return { counts, layer };
}

const definition = (name: string) =>
  restate.service({
    name,
    handlers: {
      // Requires Pool, so the layer is genuinely needed.
      whoami: restate.handler(
        { input: Schema.Void, output: Schema.Number },
        () => Effect.map(Pool, (pool: PoolShape) => pool.id)
      ),
    },
  });

describe("application runtime", () => {
  it("builds the layer once for an endpoint, not once per service", async () => {
    const { counts, layer } = countingLayer();
    const services = [definition("a"), definition("b"), definition("c")];

    restate.bind({ services, layer });
    const contexts = await Promise.all(
      services.map((s) => slotOf(s).context())
    );

    expect(counts.built).toBe(1);
    // Every service sees the same instance, so a pool in the layer is shared.
    const ids = contexts.map(
      (c: Context.Context<never>) =>
        Context.get(c as unknown as Context.Context<PoolShape>, Pool).id
    );
    expect(ids).toEqual([1, 1, 1]);
  });

  it("releases the shared layer once, however many services hold it", async () => {
    const { counts, layer } = countingLayer();
    const services = [definition("d"), definition("e")];

    restate.bind({ services, layer });
    await slotOf(services[0]!).context();
    await restate.dispose(services);

    expect(counts.built).toBe(1);
    expect(counts.released).toBe(1);
  });

  it("gives separate endpoints separate runtimes", async () => {
    const { counts, layer } = countingLayer();
    const first = [definition("f")];
    const second = [definition("g")];

    restate.bind({ services: first, layer });
    restate.bind({ services: second, layer });
    await Promise.all([...first, ...second].map((s) => slotOf(s).context()));

    // Two endpoints are two applications; sharing across them would tie their
    // lifecycles together.
    expect(counts.built).toBe(2);
  });

  it("works with no layer at all", async () => {
    // What lets an Effect service be registered with the plain SDK endpoint.
    const services = [definition("h")];
    restate.bind({ services });
    await expect(slotOf(services[0]!).context()).resolves.toBeDefined();
  });
});

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

// The endpoint (DESIGN §3.3, §6.1).
// =============================================================================
//
// `serve` binds Effect services to a Restate endpoint and binds the application
// `Layer` to them. The layer is built once per process: pools, config and
// clients are shared by every invocation, while each invocation gets its own
// journaled Clock/Random/Console and deterministic scheduler on top.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Layer } from "effect";
import * as restate from "@restatedev/restate-sdk";
import type { EffectDefinitionExtras } from "./define.js";

/** A definition produced by `service` / `object` / `workflow`. */
export type EffectDefinition<R> = EffectDefinitionExtras<R> & {
  readonly name: string;
};

/** Endpoint options shared by `serve` and `createEndpointHandler`. */
export type EndpointConfig<R> = {
  /** The Effect services, virtual objects and workflows to expose. */
  readonly services: ReadonlyArray<EffectDefinition<R>>;
  /**
   * The application services every handler may use. Built once per process.
   *
   * Required when any handler needs services; omit it when they need none. If a
   * capability marker (`StateWrite`, `DurablePromise`, …) shows up here as
   * unsatisfiable, a handler is using an operation its kind does not allow.
   */
  readonly layer?: Layer.Layer<R, any, never>;
  /** Request-identity public keys; incoming requests must be signed by one. */
  readonly identityKeys?: string[];
  /** Default options applied to every service. */
  readonly defaultServiceOptions?: restate.DefaultServiceOptions;
  /** Replace the SDK's console logger transport. */
  readonly logger?: restate.LoggerTransport;
};

/**
 * Serve these services over HTTP/2, listening on `port` (or `$PORT`, or 9080).
 *
 * ```ts
 * restate.serve({ services: [greeter], layer: AppLayer, port: 9080 });
 * ```
 */
export function serve<R>(
  config: EndpointConfig<R> & { readonly port?: number }
): Promise<number> {
  const { port, ...rest } = config;
  return restate.serve({ port, ...endpointOptions(rest) });
}

/**
 * A request handler for these services, for when you own the HTTP server.
 *
 * ```ts
 * const handler = restate.createEndpointHandler({ services: [greeter], layer: AppLayer });
 * http2.createServer(handler).listen(9080);
 * ```
 */
export function createEndpointHandler<R>(
  config: EndpointConfig<R> & { readonly bidirectional?: boolean }
): ReturnType<typeof restate.createEndpointHandler> {
  const { bidirectional, ...rest } = config;
  return restate.createEndpointHandler({
    bidirectional,
    ...endpointOptions(rest),
  });
}

/**
 * Bind the application layer to these services and return plain SDK endpoint
 * options — for embedding Effect services in an endpoint that also serves
 * promise-SDK or `restate-sdk-gen` services:
 *
 * ```ts
 * restate.serve({
 *   services: [...restate.bind({ services: [greeter], layer: AppLayer }), promiseService],
 * });
 * ```
 */
export function bind<R>(config: {
  readonly services: ReadonlyArray<EffectDefinition<R>>;
  readonly layer?: Layer.Layer<R, any, never>;
}): ReadonlyArray<restate.EndpointOptions["services"][number]> {
  const owner = config.services[0];
  if (config.layer !== undefined && owner !== undefined) {
    // One runtime for the endpoint, not one per definition: the layer is built
    // once, so a pool inside it is shared by every service here. The first
    // definition's slot owns it and the rest delegate (TODO S1-8).
    for (const definition of config.services.slice(1)) {
      definition._appRuntime.shareWith(owner._appRuntime);
    }
    owner._appRuntime.provide(config.layer);
  }
  return config.services as unknown as ReadonlyArray<
    restate.EndpointOptions["services"][number]
  >;
}

/** Release the application layer's resources. */
export function dispose<R>(
  services: ReadonlyArray<EffectDefinition<R>>
): Promise<void> {
  return Promise.all(
    services.map((definition) => definition._appRuntime.dispose())
  ).then(() => undefined);
}

function endpointOptions<R>(
  config: EndpointConfig<R>
): restate.EndpointOptions {
  const services = bind({
    services: config.services,
    layer: config.layer,
  });
  return {
    services: services as restate.EndpointOptions["services"],
    identityKeys: config.identityKeys,
    defaultServiceOptions: config.defaultServiceOptions,
    logger: config.logger,
  };
}

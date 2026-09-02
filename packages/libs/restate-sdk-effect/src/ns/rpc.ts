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

// The `rpc` namespace: call options, and calls addressed by name.
//
// Imported as a group (`restate.rpc.opts(...)`) so the root export surface
// stays about authoring. `opts`/`sendOpts` are the promise SDK's own branded
// wrappers, re-exported rather than reinvented — the brand is what makes a
// void-input client call unambiguous, and using the same one keeps a single
// call shape across the Effect, promise and gen SDKs.

import * as restate from "@restatedev/restate-sdk";

/**
 * Options for a request-response client call.
 *
 * ```ts
 * yield* client(Greeter).greet("Sam", rpc.opts({ idempotencyKey: "x" }));
 * ```
 */
export const opts = restate.rpc.opts;

/**
 * Options for a one-way send — `delay`, plus everything {@link opts} takes.
 *
 * ```ts
 * yield* sendClient(Greeter).greet("later", rpc.sendOpts({ delay: 60_000 }));
 * ```
 */
export const sendOpts = restate.rpc.sendOpts;

export { call, callDetached as detached, send } from "../client.js";
export type { CallRequest, SendRequest } from "../client.js";

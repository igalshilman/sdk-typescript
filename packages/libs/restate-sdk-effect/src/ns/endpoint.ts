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

// The `endpoint` namespace: serving these definitions somewhere other than
// `serve`. `serve` itself stays at the root — it is the common case.

export {
  bind,
  createEndpointHandler as createHandler,
  dispose,
} from "../endpoint.js";
export type { EffectDefinition, EndpointConfig } from "../endpoint.js";

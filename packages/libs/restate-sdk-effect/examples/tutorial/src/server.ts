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

// Tutorial entry point: one endpoint, six tiers.
//
//   /basics    journaled steps, concurrency, races, bounded fan-out
//   /time      durable sleep, durable timeout, durable retry
//   /saga      compensation with Effect.exit, and with acquireRelease
//   /cart      virtual-object state; shared vs exclusive handlers
//   /approval  a workflow: durable promise, background fiber, deadline
//   /users     application services from a Layer
//
// Run it:
//   pnpm --filter @restatedev/restate-sdk-effect start:tutorial
//   restate deployments register http://localhost:9080

import * as restate from "@restatedev/restate-sdk-effect";
import { basics } from "./01-basics.js";
import { time } from "./02-durable-time.js";
import { saga } from "./03-saga.js";
import { cart } from "./04-state.js";
import { approval } from "./05-workflow.js";
import { DbLayer, users } from "./06-layers.js";

// One layer for the whole endpoint: handlers that need nothing simply do not
// mention it. (`restate.endpoint.bind` is the other option — it hands plain SDK
// definitions to an endpoint that also serves promise-SDK services.)
void restate.serve({
  services: [basics, time, saga, cart, approval, users],
  layer: DbLayer,
  port: parseInt(process.env.PORT ?? "9080", 10),
});

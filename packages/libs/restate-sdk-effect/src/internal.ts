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

// Test seam — NOT part of the public API.
//
// Tests and benchmarks import these directly (`../src/internal.js`). `index.ts`
// does not re-export them and tsdown only bundles `index.ts`, so none of these
// names reach the published `dist/`.

export {
  AttemptEndedError,
  Driver,
  UnjournaledAsyncError,
} from "./internal/driver.js";
export type { DriverOptions, SourceHandle } from "./internal/driver.js";
export {
  DeterministicDispatcher,
  DeterministicScheduler,
  drainToQuiescence,
} from "./internal/effect4.js";
export type { Awaitable, RestateLib, Settled } from "./internal/lib.js";
export { adapt, defaultLib } from "./internal/default-lib.js";
export { linkAbortController } from "./internal/abort.js";
export { invocationContext, invoke } from "./internal/runtime.js";
export type { HandlerKind } from "./internal/runtime.js";
export { AppRuntimeSlot } from "./internal/app-runtime.js";

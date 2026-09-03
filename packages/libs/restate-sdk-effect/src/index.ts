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

/**
 * Run [Effect](https://effect.website) programs durably on
 * [Restate](https://restate.dev).
 *
 * ```ts
 * import { Effect, Schema } from "effect";
 * import * as restate from "@restatedev/restate-sdk-effect";
 *
 * const greeter = restate.service({
 *   name: "greeter",
 *   handlers: {
 *     greet: restate.handler(
 *       { input: Schema.String, output: Schema.String },
 *       (name) =>
 *         Effect.gen(function* () {
 *           const id = yield* Effect.sync(() => crypto.randomUUID()).pipe(
 *             restate.activity("gen-id", { result: Schema.String })
 *           );
 *           yield* Effect.sleep("1 hour"); // a durable timer
 *           return `Hello ${name} (${id})`;
 *         })
 *     ),
 *   },
 * });
 *
 * restate.serve({ services: [greeter] });
 * ```
 *
 * Everything Effect gives you — `forkChild`, `race`, concurrent `all`, `Queue`,
 * `Semaphore`, `retry(Schedule)`, `timeout` — works, and works durably: fiber
 * interleaving over durable operations is replayed from the journal rather than
 * from wall-clock timing.
 *
 * Three rules (see the README):
 *
 *  1. all real-world effects go through {@link activity};
 *  2. no `Date.now()` / `Math.random()` in handler code — `Clock` and `Random`
 *     are journaled;
 *  3. values that cross the journal are Schema-governed.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// authoring
// ---------------------------------------------------------------------------
export {
  handler,
  implement,
  object,
  service,
  sharedHandler,
  workflow,
} from "./define.js";
export type {
  EffectObjectDefinition,
  EffectServiceDefinition,
  EffectWorkflowDefinition,
  Handler,
  HandlerOptions,
  ImplementationOf,
} from "./define.js";

export { serve } from "./endpoint.js";

// ---------------------------------------------------------------------------
// durable operations
// ---------------------------------------------------------------------------
export { activity, run } from "./run.js";
export type {
  ActivityOptions,
  ActivityRequirements,
  RestateOperationsAreNotAllowedInsideActivity,
  RestateOperationsAreNotAllowedInsideRun,
  RetryOptions,
  RunOptions,
  RunRequirements,
} from "./run.js";

export {
  attach,
  awakeable,
  cancel,
  handlerRequest,
  key,
  rejectAwakeable,
  resolveAwakeable,
  signal,
  state,
  terminalError,
  uuid,
  workflowPromise,
} from "./ops.js";
export type {
  Awakeable,
  Codec,
  HandlerRequest,
  StateCell,
  StateOps,
  WorkflowPromise,
} from "./ops.js";

export {
  client,
  decodeFailure,
  invocation,
  scope,
  sendClient,
} from "./client.js";
export type {
  Client,
  InvocationHandle,
  InvocationRef,
  SendClient,
  SignalHandle,
} from "./client.js";

// ---------------------------------------------------------------------------
// grouped surfaces
// ---------------------------------------------------------------------------

/** Calls addressed by name, and the branded call options. */
export * as rpc from "./ns/rpc.js";
/** Serving these definitions somewhere other than {@link serve}. */
export * as endpoint from "./ns/endpoint.js";
/** Escape hatches outside what this runtime can check. */
export * as unsafe from "./ns/unsafe.js";
/** Observing the invocation, never driving it. */
export * as diagnostics from "./ns/diagnostics.js";
/** Machinery that public signatures name. Not stable; not for hand use. */
export * as internals from "./ns/internals.js";

// ---------------------------------------------------------------------------
// context, capabilities, errors, serde
// ---------------------------------------------------------------------------
export {
  DurablePromise,
  ObjectKey,
  RestateContext,
  RunSignal,
  StateRead,
  StateWrite,
} from "./context.js";
export type { RestateCapability, RestateInvocation } from "./context.js";

export {
  isCancellation,
  isTimeout,
  RestateFailure,
  toRestateFailure,
} from "./errors.js";

/**
 * Restate's error classes, re-exported for convenience: a `run` closure that
 * must fail *terminally* throws one of these, and `RestateFailure.terminal`
 * carries one.
 */
export {
  CancelledError,
  RestateError,
  TerminalError,
  TimeoutError,
} from "@restatedev/restate-sdk";

export { schemaSerde } from "./serde.js";
export type { AnySchema, SchemaType } from "./serde.js";

// ---------------------------------------------------------------------------
// contracts — one import for a service package
// ---------------------------------------------------------------------------
export { iface } from "./iface.js";
export type {
  EffectServiceInterface,
  SchemaDeclarators,
  SharedSchemaDeclarators,
} from "./iface.js";
export { serde } from "@restatedev/restate-sdk-core";

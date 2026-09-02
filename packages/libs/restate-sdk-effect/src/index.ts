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
 *           const id = yield* restate.run(
 *             "gen-id",
 *             Effect.sync(() => crypto.randomUUID())
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
 *  1. all real-world async goes through {@link run};
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
  AppRuntimeBinding,
  EffectDefinitionExtras,
  EffectHandlerImpl,
  Capabilities,
  HandlerKindFor,
  Handlers,
  HandlersRequire,
  Requires,
  EffectObjectDefinition,
  EffectServiceDefinition,
  EffectWorkflowDefinition,
  Handler,
  HandlerDescriptors,
  HandlerOptions,
  ImplementationOf,
} from "./define.js";

export { bind, createEndpointHandler, dispose, serve } from "./endpoint.js";
export type { EffectDefinition, EndpointConfig } from "./endpoint.js";

// ---------------------------------------------------------------------------
// durable operations
// ---------------------------------------------------------------------------
export { run, runExit } from "./run.js";
export type {
  RestateOperationsAreNotAllowedInsideRun,
  RetryOptions,
  RunOptions,
  RunRequirements,
} from "./run.js";

export {
  abortSignal,
  attach,
  awakeable,
  cancel,
  durable,
  handlerRequest,
  isProcessing,
  key,
  rawContext,
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
  StateOps,
  WorkflowPromise,
} from "./ops.js";

export {
  call,
  callDetached,
  client,
  decodeFailure,
  invocation,
  scope,
  send,
  sendClient,
} from "./client.js";
export type {
  CallOptions,
  CallRequest,
  Client,
  InvocationHandle,
  InvocationRef,
  SendClient,
  SendOptions,
  SendRequest,
  SignalHandle,
} from "./client.js";

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
export type {
  InvocationDriver,
  RestateCapability,
  RestateInvocation,
} from "./context.js";

export type { Awaitable } from "./internal/lib.js";

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

export type { HandlerKind } from "./internal/runtime.js";

// ---------------------------------------------------------------------------
// contracts — re-exported so a service package needs one import
// ---------------------------------------------------------------------------
export { iface, serde } from "@restatedev/restate-sdk-core";
export type {
  Descriptor,
  HandlerDescriptor,
  ImplementedDefinition,
  ImplementedObjectDefinition,
  ImplementedServiceDefinition,
  ImplementedWorkflowDefinition,
  ObjectDescriptor,
  Serde,
  ServiceDefinition,
  ServiceDescriptor,
  SerdeType,
  ServiceInterface,
  StandardSchemaV1,
  StandardTypedV1,
  VirtualObjectDefinition,
  WorkflowDefinition,
  WorkflowDescriptor,
} from "@restatedev/restate-sdk-core";

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

// The `internals` namespace.
//
// Types that appear in public signatures — so they have to be reachable, or the
// generated `.d.ts` would reference names it does not export — but that nobody
// writes by hand. They live here so the root export stays about authoring
// rather than about the machinery underneath it.
//
// Nothing here is stable. Depending on it means depending on how the runtime
// happens to be built.

export type {
  AppRuntimeBinding,
  BareImplementation,
  Capabilities,
  DeclaredError,
  EffectDefinitionExtras,
  EffectHandlerImpl,
  HandlerDescriptors,
  HandlerKindFor,
  Handlers,
  HandlersRequire,
  ImplementationRequire,
  ImplementationRequires,
  ImplementedHandlers,
  Requires,
  ServiceHandlerShape,
  WorkflowHandlerShape,
} from "../define.js";
export type { InvocationDriver } from "../context.js";
export type { Awaitable } from "../internal/lib.js";
export type { HandlerKind } from "../internal/runtime.js";

/**
 * The contract types this package builds on, re-exported so a generated
 * declaration can name them. Import them from `@restatedev/restate-sdk-core`
 * directly if you need them in your own code.
 */
export type {
  Descriptor,
  HandlerDescriptor,
  ImplementedDefinition,
  ImplementedObjectDefinition,
  ImplementedServiceDefinition,
  ImplementedWorkflowDefinition,
  ObjectDescriptor,
  Serde,
  SerdeType,
  ServiceDefinition,
  ServiceDescriptor,
  ServiceInterface,
  StandardSchemaV1,
  StandardTypedV1,
  VirtualObjectDefinition,
  WorkflowDefinition,
  WorkflowDescriptor,
} from "@restatedev/restate-sdk-core";

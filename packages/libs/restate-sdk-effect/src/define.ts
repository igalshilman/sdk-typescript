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

// Authoring surface (DESIGN §6.1).
// =============================================================================
//
// A handler is `(input) => Effect<Output, DomainError, R>`. `service`, `object`
// and `workflow` turn a map of them into an ordinary Restate definition — the
// `Implemented*Definition` shape from `@restatedev/restate-sdk-core` — so an
// Effect service is bindable to any endpoint and callable from promise-SDK,
// `restate-sdk-gen` and Effect clients alike.
//
// The requirement type `R` is tracked on the definition (minus the capabilities
// the handler kind provides) and checked against the `Layer` given to `serve`.
// A capability the kind does *not* provide — writing state from a shared
// handler, using a workflow promise in a plain service — stays in `R` and no
// layer can supply it, which is the compile error we want.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */

import type { Effect, Layer, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk";
import {
  makeHandlerDescriptor,
  type Descriptor,
  type HandlerDescriptor,
  type ImplementedObjectDefinition,
  type ImplementedServiceDefinition,
  type ImplementedWorkflowDefinition,
} from "@restatedev/restate-sdk-core";
import type {
  DurablePromise,
  ObjectKey,
  RestateCapability,
  RestateContext,
  StateRead,
  StateWrite,
} from "./context.js";
import { AppRuntimeSlot } from "./internal/app-runtime.js";
import { type HandlerKind, invoke } from "./internal/runtime.js";
import { type AnySchema, type SchemaType, toSerde } from "./serde.js";

// ---------------------------------------------------------------------------
// handler definitions
// ---------------------------------------------------------------------------

/** Options accepted by every handler. */
export type HandlerOptions<I, O, E> = {
  /** Codec for the handler's input. Defaults to JSON. */
  readonly input?: Schema.Codec<I, any> | restate.Serde<I>;
  /** Codec for the handler's output. Defaults to JSON. */
  readonly output?: Schema.Codec<O, any> | restate.Serde<O>;
  /**
   * Codec for the handler's declared domain errors. Required for a handler
   * whose effect can fail: a failure is encoded with this codec into the
   * terminal error's body, and callers decode it back with
   * `restate.decodeFailure`.
   */
  readonly error?: Schema.Codec<E, any>;
  /** Terminal error code for declared failures. Defaults to 500. */
  readonly errorCode?: number;
  /** Enable lazy state for invocations of this handler (Restate 1.4+). */
  readonly enableLazyState?: boolean;
  /** Human-readable description, surfaced in discovery. */
  readonly description?: string;
  /** Metadata surfaced in discovery. */
  readonly metadata?: Record<string, string>;
};

/** A handler bound to its codecs. Produced by {@link handler}. */
export type Handler<
  I,
  O,
  R,
  Shared extends boolean = false,
> = HandlerDescriptor<I, O, Shared> & {
  /** @internal */
  readonly _effectHandler: EffectHandlerImpl<I, O>;
  /** Phantom: services this handler needs from the application layer. */
  readonly _requires?: R;
};

/**
 * A handler's implementation. Part of the published types because `Handler`
 * carries it; its shape is internal and may change.
 */
export type EffectHandlerImpl<I, O> = {
  readonly fn: (input: I) => Effect.Effect<O, any, any>;
  readonly shared: boolean;
  readonly encodeFailure: (failure: any) => restate.TerminalError;
  readonly options: {
    readonly enableLazyState?: boolean;
    readonly description?: string;
    readonly metadata?: Record<string, string>;
  };
};

/** Capabilities available to each handler kind. */
export type Capabilities<K extends HandlerKind> = K extends "service"
  ? RestateContext
  : K extends "object"
    ? RestateContext | ObjectKey | StateRead | StateWrite
    : K extends "objectShared"
      ? RestateContext | ObjectKey | StateRead
      : K extends "workflow"
        ? RestateContext | ObjectKey | StateRead | StateWrite | DurablePromise
        : RestateContext | ObjectKey | StateRead | DurablePromise;

/**
 * What a handler still needs from the application layer: its `R` minus the
 * capabilities its kind provides. A capability the kind does not provide stays
 * behind and can never be satisfied — the intended compile error.
 */
export type Requires<R, K extends HandlerKind> = Exclude<R, Capabilities<K>>;

/** The kind of a single handler, given its definition kind, sharedness, name. */
export type HandlerKindFor<
  K extends "service" | "object" | "workflow",
  Shared extends boolean,
  Name extends PropertyKey,
> = K extends "service"
  ? "service"
  : K extends "object"
    ? Shared extends true
      ? "objectShared"
      : "object"
    : Name extends "run"
      ? "workflow"
      : "workflowShared";

/**
 * Define a handler.
 *
 * ```ts
 * greet: restate.handler(
 *   { input: Schema.String, output: Schema.String, error: EmptyName },
 *   (name) =>
 *     Effect.gen(function* () {
 *       if (name === "") return yield* new EmptyName();
 *       return `Hello ${name}`;
 *     })
 * )
 * ```
 */
export function handler<SI extends AnySchema, SO extends AnySchema, E, R>(
  options: HandlerOptions<SchemaType<SI>, SchemaType<SO>, E> & {
    input: SI;
    output: SO;
  },
  fn: (input: SchemaType<SI>) => Effect.Effect<SchemaType<SO>, E, R>
): Handler<SchemaType<SI>, SchemaType<SO>, R, false>;
/** A handler that takes no input. */
export function handler<O, E, R>(
  options: HandlerOptions<void, O, E>,
  fn: () => Effect.Effect<O, E, R>
): Handler<void, O, R, false>;
export function handler<I, O, E, R>(
  options: HandlerOptions<I, O, E>,
  fn: (input: I) => Effect.Effect<O, E, R>
): Handler<I, O, R, false>;
export function handler(
  options: HandlerOptions<any, any, any>,
  fn: (input: any) => Effect.Effect<any, any, any>
): Handler<any, any, any, false> {
  return makeHandler(options, fn, false);
}

/**
 * Define a *shared* handler: a read-only virtual-object handler, or a
 * non-`run` workflow handler. Shared handlers run concurrently with the
 * exclusive one, so they may read state but not write it.
 */
export function sharedHandler<SI extends AnySchema, SO extends AnySchema, E, R>(
  options: HandlerOptions<SchemaType<SI>, SchemaType<SO>, E> & {
    input: SI;
    output: SO;
  },
  fn: (input: SchemaType<SI>) => Effect.Effect<SchemaType<SO>, E, R>
): Handler<SchemaType<SI>, SchemaType<SO>, R, true>;
/** A shared handler that takes no input. */
export function sharedHandler<O, E, R>(
  options: HandlerOptions<void, O, E>,
  fn: () => Effect.Effect<O, E, R>
): Handler<void, O, R, true>;
export function sharedHandler<I, O, E, R>(
  options: HandlerOptions<I, O, E>,
  fn: (input: I) => Effect.Effect<O, E, R>
): Handler<I, O, R, true>;
export function sharedHandler(
  options: HandlerOptions<any, any, any>,
  fn: (input: any) => Effect.Effect<any, any, any>
): Handler<any, any, any, true> {
  return makeHandler(options, fn, true);
}

function makeHandler(
  options: HandlerOptions<any, any, any>,
  fn: (input: any) => Effect.Effect<any, any, any>,
  shared: boolean
): Handler<any, any, any, any> {
  const descriptor = makeHandlerDescriptor(
    toSerde(options.input),
    toSerde(options.output),
    shared
  );
  return {
    ...descriptor,
    _effectHandler: {
      fn,
      shared,
      encodeFailure: makeFailureEncoder(options),
      options: {
        enableLazyState: options.enableLazyState,
        description: options.description,
        metadata: options.metadata,
      },
    },
  };
}

/**
 * Encode a declared domain failure into a terminal error whose message is the
 * Schema-encoded JSON body. A failure that does not match the declared codec —
 * classification drift — is a defect instead, so a mis-declared error never
 * silently encodes as something else.
 */
function makeFailureEncoder(
  options: HandlerOptions<any, any, any>
): (failure: any) => restate.TerminalError {
  const errorCode = options.errorCode ?? 500;
  const codec = options.error;
  if (codec === undefined) {
    return (failure: unknown) => {
      throw failure instanceof Error
        ? failure
        : new Error(
            "@restatedev/restate-sdk-effect: handler failed with an " +
              "undeclared error. Declare it with `error:` in the handler " +
              `options, or handle it inside the handler. Value: ${String(failure)}`
          );
    };
  }
  const serde = toSerde(codec);
  return (failure: unknown) => {
    let body: string;
    try {
      body = new TextDecoder().decode(serde!.serialize(failure as never));
    } catch (e) {
      // Declared-error encoding failed: that is a bug in the error schema, not
      // a domain outcome. Retry rather than report a malformed terminal error.
      throw e instanceof Error ? e : new Error(String(e));
    }
    return new restate.TerminalError(body, { errorCode });
  };
}

// ---------------------------------------------------------------------------
// service / object / workflow
// ---------------------------------------------------------------------------

/** A map of handlers, as passed to `service` / `object` / `workflow`. */
export type Handlers = Record<string, Handler<any, any, any, any>>;

/** Descriptor map derived from a handler map. */
export type HandlerDescriptors<H extends Handlers> = {
  [K in keyof H]: H[K] extends Handler<infer I, infer O, any, any>
    ? HandlerDescriptor<I, O>
    : never;
};

/** Requirements of every handler in the map, for handler kind `K`. */
export type HandlersRequire<
  H extends Handlers,
  K extends "service" | "object" | "workflow",
> = {
  [N in keyof H]: H[N] extends Handler<any, any, infer R, infer S>
    ? Requires<R, HandlerKindFor<K, S, N>>
    : never;
}[keyof H];

/** An Effect service definition, carrying what its handlers still need. */
export type EffectServiceDefinition<
  P extends string,
  H extends Handlers,
  R,
> = ImplementedServiceDefinition<P, HandlerDescriptors<H>> &
  EffectDefinitionExtras<R>;

/** An Effect virtual-object definition. */
export type EffectObjectDefinition<
  P extends string,
  H extends Handlers,
  R,
> = ImplementedObjectDefinition<P, HandlerDescriptors<H>> &
  EffectDefinitionExtras<R>;

/** An Effect workflow definition. */
export type EffectWorkflowDefinition<
  P extends string,
  H extends Handlers,
  R,
> = ImplementedWorkflowDefinition<P, HandlerDescriptors<H>> &
  EffectDefinitionExtras<R>;

/**
 * What a contract demands of an implementation: every handler the descriptor
 * declares, with its input, output and shared/exclusive marker.
 *
 * This is {@link implement}'s constraint, so `implement(contract, {})` is a
 * compile error rather than a definition with no handlers. Requirements (`R`)
 * stay free — that is what the implementation contributes. Handlers *beyond*
 * the contract are still accepted; only object literals get excess-property
 * checking, and a contract is a lower bound, not an upper one.
 */
export type ImplementationOf<
  D extends Descriptor<string, Record<string, HandlerDescriptor>, any>,
> = {
  readonly [N in keyof D["_handlers"]]: D["_handlers"][N] extends HandlerDescriptor<
    infer I,
    infer O,
    infer Shared
  >
    ? Handler<I, O, any, Shared extends true ? true : false>
    : never;
};

/**
 * The endpoint's hook for binding the application layer to a definition. Part
 * of the published types because every definition carries one; not something to
 * call yourself.
 */
export interface AppRuntimeBinding {
  provide<R, E>(layer: Layer.Layer<R, E, never>): void;
  /**
   * Share another definition's runtime instead of building one. The endpoint
   * calls this so a layer is built once per endpoint, not once per service.
   */
  shareWith(target: AppRuntimeBinding): void;
  dispose(): Promise<void>;
}

/** Common tail of every Effect definition. */
export type EffectDefinitionExtras<R> = {
  /** Filled in by the endpoint with the application runtime. */
  readonly _appRuntime: AppRuntimeBinding;
  /** Phantom: services this definition needs from the application layer. */
  readonly _requires?: R;
};

/** Any Effect definition, as accepted by {@link serve}. */
export type AnyEffectDefinition<R> = EffectDefinitionExtras<R> & {
  readonly name: string;
};

/**
 * Define a service: handlers with no key and no state.
 *
 * ```ts
 * const greeter = restate.service({
 *   name: "greeter",
 *   handlers: { greet: restate.handler({ ... }, (name) => ...) },
 * });
 * ```
 */
export function service<P extends string, H extends Handlers>(config: {
  readonly name: P;
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  readonly handlers: H;
  readonly options?: Omit<restate.ServiceOptions, "explicitCancellation">;
}): EffectServiceDefinition<P, H, HandlersRequire<H, "service">> {
  checkOptions(config.options);
  const slot = new AppRuntimeSlot();
  const coreHandlers: Record<string, any> = {};
  const descriptors: Record<string, HandlerDescriptor> = {};

  for (const [name, entry] of Object.entries(config.handlers)) {
    const impl = entry._effectHandler;
    coreHandlers[name] = restate.handlers.handler(
      sdkOptions(entry, impl),
      (ctx: restate.Context, input: unknown) =>
        invoke({
          ctx,
          effect: impl.fn(input),
          appRuntime: slot,
          kind: "service",
          encodeFailure: impl.encodeFailure,
        })
    );
    descriptors[name] = descriptorOf(entry);
  }

  return finish(
    restate.service({
      name: config.name,
      handlers: coreHandlers as any,
      description: config.description,
      metadata: config.metadata,
      options: config.options,
    }),
    "service",
    descriptors,
    slot
  ) as EffectServiceDefinition<P, H, HandlersRequire<H, "service">>;
}

/**
 * Define a virtual object: handlers keyed by an object id, with state.
 * Handlers built with {@link handler} are exclusive (one at a time, may write
 * state); handlers built with {@link sharedHandler} run concurrently and may
 * only read state.
 */
export function object<P extends string, H extends Handlers>(config: {
  readonly name: P;
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  readonly handlers: H;
  readonly options?: Omit<restate.ObjectOptions, "explicitCancellation">;
}): EffectObjectDefinition<P, H, HandlersRequire<H, "object">> {
  checkOptions(config.options);
  const slot = new AppRuntimeSlot();
  const coreHandlers: Record<string, any> = {};
  const descriptors: Record<string, HandlerDescriptor> = {};

  for (const [name, entry] of Object.entries(config.handlers)) {
    const impl = entry._effectHandler;
    const kind: HandlerKind = impl.shared ? "objectShared" : "object";
    const fn = (ctx: restate.ObjectContext, input: unknown) =>
      invoke({
        ctx: ctx as restate.Context,
        effect: impl.fn(input),
        appRuntime: slot,
        kind,
        encodeFailure: impl.encodeFailure,
      });
    coreHandlers[name] = impl.shared
      ? restate.handlers.object.shared(sdkOptions(entry, impl), fn as any)
      : restate.handlers.object.exclusive(sdkOptions(entry, impl), fn as any);
    descriptors[name] = descriptorOf(entry);
  }

  return finish(
    restate.object({
      name: config.name,
      handlers: coreHandlers as any,
      description: config.description,
      metadata: config.metadata,
      options: config.options,
    }),
    "object",
    descriptors,
    slot
  ) as EffectObjectDefinition<P, H, HandlersRequire<H, "object">>;
}

/**
 * Define a workflow: a keyed `run` handler that executes once per key, plus
 * shared handlers that can interact with a running instance.
 */
export function workflow<P extends string, H extends Handlers>(config: {
  readonly name: P;
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  readonly handlers: H;
  readonly options?: Omit<restate.WorkflowOptions, "explicitCancellation">;
}): EffectWorkflowDefinition<P, H, HandlersRequire<H, "workflow">> {
  checkOptions(config.options);
  const slot = new AppRuntimeSlot();
  const coreHandlers: Record<string, any> = {};
  const descriptors: Record<string, HandlerDescriptor> = {};

  for (const [name, entry] of Object.entries(config.handlers)) {
    const impl = entry._effectHandler;
    const isRun = name === "run";
    const kind: HandlerKind = isRun ? "workflow" : "workflowShared";
    const fn = (ctx: restate.WorkflowContext, input: unknown) =>
      invoke({
        ctx: ctx as restate.Context,
        effect: impl.fn(input),
        appRuntime: slot,
        kind,
        encodeFailure: impl.encodeFailure,
      });
    coreHandlers[name] = isRun
      ? restate.handlers.workflow.workflow(sdkOptions(entry, impl), fn as any)
      : restate.handlers.workflow.shared(sdkOptions(entry, impl), fn as any);
    descriptors[name] = descriptorOf(entry);
  }

  return finish(
    restate.workflow({
      name: config.name,
      handlers: coreHandlers as any,
      description: config.description,
      metadata: config.metadata,
      options: config.options,
    }),
    "workflow",
    descriptors,
    slot
  ) as EffectWorkflowDefinition<P, H, HandlersRequire<H, "workflow">>;
}

/**
 * Implement a contract declared with `iface` (from
 * `@restatedev/restate-sdk-core`), so contract and implementation can live in
 * different packages — the same split `restate-sdk-gen` and the promise SDK
 * offer.
 */
export function implement<
  D extends Descriptor<string, Record<string, HandlerDescriptor>, any>,
  H extends ImplementationOf<D>,
>(
  descriptor: D,
  handlers: H
): D["_kind"] extends "service"
  ? EffectServiceDefinition<D["name"], H, HandlersRequire<H, "service">>
  : D["_kind"] extends "object"
    ? EffectObjectDefinition<D["name"], H, HandlersRequire<H, "object">>
    : EffectWorkflowDefinition<D["name"], H, HandlersRequire<H, "workflow">> {
  // Inherit the contract's codecs for any handler that did not declare its own.
  const merged: Handlers = {};
  const entries = Object.entries(handlers) as Array<
    [string, Handler<any, any, any, boolean>]
  >;
  for (const [name, entry] of entries) {
    const contract = descriptor._handlers[name];
    merged[name] = {
      ...entry,
      _inputSerde: entry._inputSerde ?? contract?._inputSerde,
      _outputSerde: entry._outputSerde ?? contract?._outputSerde,
      _shared: entry._shared ?? contract?._shared,
      _effectHandler: {
        ...entry._effectHandler,
        shared: entry._effectHandler.shared || contract?._shared === true,
      },
    };
  }
  const config = { name: descriptor.name, handlers: merged };
  switch (descriptor._kind) {
    case "object":
      return object(config) as any;
    case "workflow":
      return workflow(config) as any;
    default:
      return service(config) as any;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Reject SDK options this runtime does not honor.
 *
 * `explicitCancellation` tells the promise SDK to stop propagating cancellation
 * automatically and hand it to the handler through `ctx.cancellation()`. This
 * driver never consumes that, so accepting the option would silently disable
 * cancellation instead of making it explicit. Cooperative cancellation is a
 * planned feature (DESIGN §8); until it lands, saying no is the honest answer.
 *
 * The option is also removed from the config *types*, so this throw is only
 * reachable from JavaScript or through a cast.
 */
function checkOptions(options: object | undefined) {
  if (
    options !== undefined &&
    "explicitCancellation" in options &&
    options.explicitCancellation === true
  ) {
    throw new Error(
      "@restatedev/restate-sdk-effect: `explicitCancellation` is not supported. " +
        "This runtime maps Restate cancellation onto Effect interruption and never " +
        "reads ctx.cancellation(), so enabling the option would disable cancellation " +
        "rather than make it explicit. Remove it, and handle teardown with Effect " +
        "finalizers (onInterrupt / acquireRelease / ensuring)."
    );
  }
}

function descriptorOf(entry: Handler<any, any, any>): HandlerDescriptor {
  return makeHandlerDescriptor(
    entry._inputSerde,
    entry._outputSerde,
    entry._shared
  );
}

function sdkOptions(
  entry: Handler<any, any, any>,
  impl: EffectHandlerImpl<any, any>
): any {
  return {
    input: entry._inputSerde,
    output: entry._outputSerde,
    ...impl.options,
  };
}

/** Attach our extras to an SDK definition. */
function finish(
  coreDef: object,
  kind: "service" | "object" | "workflow",
  descriptors: Record<string, HandlerDescriptor>,
  slot: AppRuntimeSlot
): unknown {
  return Object.assign(coreDef, {
    _kind: kind,
    _handlers: descriptors,
    _appRuntime: slot,
  });
}

/** Every capability, re-exported for the type-level tests. @internal */
export type AllCapabilities = RestateCapability;

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

/* eslint-disable @typescript-eslint/no-explicit-any */

// The durable primitives that need an explicit call (DESIGN §6.2).
// =============================================================================
//
// Deliberately absent: `sleep`, `timeout`, `race`, `all`. Plain `Effect.sleep`,
// `Effect.timeout`, `Effect.race`, `Effect.all` and `Effect.retry` *are* the
// durable combinators here — the invocation's `Clock` is journaled and fiber
// interleaving is replayed from the journal.

import { Effect, type Schema } from "effect";
import * as restate from "@restatedev/restate-sdk";
import type {
  DurablePromise,
  ObjectKey,
  RestateContext,
  StateRead,
  StateWrite,
} from "./context.js";
import { type RestateFailure, toRestateFailure } from "./errors.js";
import { adapt } from "./internal/default-lib.js";
import {
  contextRead,
  journal,
  syncJournal,
  withInvocation,
} from "./internal/journal.js";
import { type AnySchema, type SchemaType, toSerde } from "./serde.js";

// ---------------------------------------------------------------------------
// invocation metadata
// ---------------------------------------------------------------------------

/** This invocation's request metadata, plus the key for keyed services. */
export type HandlerRequest = Omit<restate.Request, "attemptCompletedSignal"> & {
  readonly key: string | undefined;
};

/** Request metadata: id, target, headers, idempotency key, … */
export const handlerRequest: Effect.Effect<
  HandlerRequest,
  never,
  RestateContext
> = contextRead((env) => {
  const request = env.ctx.request();
  return {
    attemptHeaders: request.attemptHeaders,
    body: request.body,
    extraArgs: request.extraArgs,
    headers: request.headers,
    id: request.id,
    target: request.target,
    // A plain service context has no key: its `key` getter *throws*, so this
    // must be gated on the handler kind rather than read speculatively.
    key:
      env.kind === "service"
        ? undefined
        : (env.ctx as unknown as { key: string }).key,
    scope: request.scope,
    idempotencyKey: request.idempotencyKey,
    limitKey: request.limitKey,
  };
});

/** The virtual-object / workflow key of this invocation. */
export const key: Effect.Effect<string, never, RestateContext | ObjectKey> =
  contextRead((env) => (env.ctx as unknown as { key: string }).key);

/**
 * True while this attempt is processing rather than replaying.
 *
 * **Never branch on this.** It exists for diagnostics; using it to influence
 * control flow produces a journal mismatch by construction.
 */
export const isProcessing: Effect.Effect<boolean, never, RestateContext> =
  contextRead((env) => env.ctx.isProcessing());

/**
 * A deterministic UUID v4, seeded by the invocation id.
 *
 * Predictable by design — never use it as a secret. `Random` (Effect's own
 * service) is journaled the same way for numbers.
 */
export const uuid: Effect.Effect<string, never, RestateContext> = contextRead(
  (env) => env.ctx.rand.uuidv4()
);

/**
 * An `AbortSignal` for this invocation, aborted when cancellation arrives or
 * the attempt ends. Rarely needed: `restate.run` closures already receive
 * cancellation through their own signal.
 */
export const abortSignal: Effect.Effect<AbortSignal, never, RestateContext> =
  contextRead((env) => env.driver.abortSignal);

/**
 * Fail terminally: the invocation stops, the failure is recorded, and Restate
 * does not retry. The caller sees `message` with `options.code`.
 *
 * Prefer declaring domain errors with a Schema (`error:` in the handler
 * options) — this is the escape hatch for failures that have no schema, and the
 * direct equivalent of `throw new restate.TerminalError(...)` in the other
 * SDKs.
 */
export function terminalError(
  message: string,
  options?: {
    /** Restate error code, an HTTP status code by convention. Default 500. */
    readonly code?: number;
    /** Metadata recorded with the failure (Restate 1.6+). */
    readonly metadata?: Record<string, string>;
  }
): Effect.Effect<never, RestateFailure> {
  return Effect.fail(
    toRestateFailure(
      new restate.TerminalError(message, {
        errorCode: options?.code,
        metadata: options?.metadata,
      })
    )
  );
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/**
 * Virtual-object and workflow state, Schema-typed per key.
 *
 * Reads need `StateRead`, writes need `StateWrite`. A shared handler is only
 * given `StateRead`, so writing state from one is a compile error rather than a
 * runtime surprise.
 */
/** Read a state value, or `null` when it is not set. */
function stateGet<S extends AnySchema>(
  name: string,
  codec: S
): Effect.Effect<
  SchemaType<S> | null,
  RestateFailure,
  RestateContext | StateRead
>;
/** Read a state value as JSON, or `null` when it is not set. */
function stateGet<T = unknown>(
  name: string
): Effect.Effect<T | null, RestateFailure, RestateContext | StateRead>;
function stateGet(
  name: string,
  codec?: AnySchema
): Effect.Effect<unknown, RestateFailure, RestateContext | StateRead> {
  const serde = toSerde<unknown>(codec);
  return journal(`state.get(${name})`, (env) =>
    adapt(
      (env.ctx as unknown as restate.ObjectSharedContext).get<unknown>(
        name,
        serde
      ) as restate.RestatePromise<unknown>
    )
  );
}

/** All state keys of this object. */
function stateKeys(): Effect.Effect<
  string[],
  RestateFailure,
  RestateContext | StateRead
> {
  return journal("state.keys()", (env) =>
    adapt(
      (
        env.ctx as unknown as restate.ObjectSharedContext
      ).stateKeys() as restate.RestatePromise<string[]>
    )
  );
}

/** Write a state value. */
function stateSet<S extends AnySchema>(
  name: string,
  codec: S,
  value: SchemaType<S>
): Effect.Effect<void, never, RestateContext | StateWrite>;
/** Write a state value as JSON. */
function stateSet<T>(
  name: string,
  value: T
): Effect.Effect<void, never, RestateContext | StateWrite>;
function stateSet(
  name: string,
  codecOrValue: unknown,
  maybeValue?: unknown
): Effect.Effect<void, never, RestateContext | StateWrite> {
  // Two forms: (name, codec, value) and (name, value).
  const hasCodec = arguments.length >= 3;
  const serde = hasCodec
    ? toSerde<unknown>(codecOrValue as AnySchema)
    : undefined;
  const value = hasCodec ? maybeValue : codecOrValue;
  return syncJournal(`state.set(${name})`, (env) => {
    (env.ctx as unknown as restate.ObjectContext).set(name, value, serde);
  });
}

/** Delete one state value. */
function stateClear(
  name: string
): Effect.Effect<void, never, RestateContext | StateWrite> {
  return syncJournal(`state.clear(${name})`, (env) => {
    (env.ctx as unknown as restate.ObjectContext).clear(name);
  });
}

/** Delete all state of this object. */
function stateClearAll(): Effect.Effect<
  void,
  never,
  RestateContext | StateWrite
> {
  return syncJournal("state.clearAll()", (env) => {
    (env.ctx as unknown as restate.ObjectContext).clearAll();
  });
}

/** The shape of {@link state}. */
export interface StateOps {
  /** Read a state value, or `null` when it is not set. */
  get<S extends AnySchema>(
    name: string,
    codec: S
  ): Effect.Effect<
    SchemaType<S> | null,
    RestateFailure,
    RestateContext | StateRead
  >;
  /** Read a state value as JSON, or `null` when it is not set. */
  get<T = unknown>(
    name: string
  ): Effect.Effect<T | null, RestateFailure, RestateContext | StateRead>;
  /** All state keys of this object. */
  keys(): Effect.Effect<string[], RestateFailure, RestateContext | StateRead>;
  /** Write a state value. */
  set<S extends AnySchema>(
    name: string,
    codec: S,
    value: SchemaType<S>
  ): Effect.Effect<void, never, RestateContext | StateWrite>;
  /** Write a state value as JSON. */
  set<T>(
    name: string,
    value: T
  ): Effect.Effect<void, never, RestateContext | StateWrite>;
  /** Delete one state value. */
  clear(name: string): Effect.Effect<void, never, RestateContext | StateWrite>;
  /** Delete all state of this object. */
  clearAll(): Effect.Effect<void, never, RestateContext | StateWrite>;
}

export const state: StateOps = {
  get: stateGet,
  keys: stateKeys,
  set: stateSet,
  clear: stateClear,
  clearAll: stateClearAll,
};

// ---------------------------------------------------------------------------
// awakeables
// ---------------------------------------------------------------------------

/** An awakeable: an id to hand out, and an effect that waits for its result. */
export interface Awakeable<T> {
  /** Pass this to whoever will complete the awakeable. */
  readonly id: string;
  /** Waits for the awakeable to be resolved or rejected. */
  readonly result: Effect.Effect<T, RestateFailure, RestateContext>;
}

/**
 * Create an awakeable — a durable promise completed from outside, by id.
 *
 * ```ts
 * const cb = yield* restate.awakeable(Schema.String);
 * yield* restate.run("ask", requestApproval(cb.id));
 * const decision = yield* cb.result; // suspends until someone resolves it
 * ```
 */
export function awakeable<S extends AnySchema>(
  codec: S
): Effect.Effect<Awakeable<SchemaType<S>>, never, RestateContext>;
/** Create an awakeable whose payload is plain JSON. */
export function awakeable<T = void>(): Effect.Effect<
  Awakeable<T>,
  never,
  RestateContext
>;
export function awakeable<S extends AnySchema>(
  codec?: S
): Effect.Effect<Awakeable<unknown>, never, RestateContext> {
  return syncJournal("awakeable()", (env) => {
    const { id, promise } = env.ctx.awakeable<unknown>(
      toSerde<unknown>(codec as AnySchema | undefined)
    );
    return {
      id,
      result: journal(`awakeable.result(${id})`, () => adapt(promise)),
    };
  });
}

/** Resolve someone else's awakeable. */
export function resolveAwakeable<S extends AnySchema>(
  id: string,
  codec: S,
  payload: SchemaType<S>
): Effect.Effect<void, never, RestateContext>;
/** Resolve with a JSON payload. */
export function resolveAwakeable<T>(
  id: string,
  payload: T
): Effect.Effect<void, never, RestateContext>;
export function resolveAwakeable(
  id: string
): Effect.Effect<void, never, RestateContext>;
export function resolveAwakeable(
  id: string,
  codecOrPayload?: unknown,
  maybePayload?: unknown
): Effect.Effect<void, never, RestateContext> {
  const hasCodec = arguments.length >= 3;
  const serde = hasCodec
    ? toSerde<unknown>(codecOrPayload as AnySchema)
    : undefined;
  const payload = hasCodec ? maybePayload : codecOrPayload;
  return syncJournal(`resolveAwakeable(${id})`, (env) => {
    env.ctx.resolveAwakeable(id, payload, serde);
  });
}

/** Reject someone else's awakeable; the waiter sees a terminal failure. */
export function rejectAwakeable(
  id: string,
  reason: string
): Effect.Effect<void, never, RestateContext> {
  return syncJournal(`rejectAwakeable(${id})`, (env) => {
    env.ctx.rejectAwakeable(id, reason);
  });
}

// ---------------------------------------------------------------------------
// signals, attach, cancel
// ---------------------------------------------------------------------------

/** Wait for a named signal sent to this invocation. */
export function signal<S extends AnySchema>(
  name: string,
  codec: S
): Effect.Effect<SchemaType<S>, RestateFailure, RestateContext>;
export function signal<T = unknown>(
  name: string
): Effect.Effect<T, RestateFailure, RestateContext>;
export function signal(
  name: string,
  codec?: AnySchema
): Effect.Effect<unknown, RestateFailure, RestateContext> {
  const serde = toSerde<unknown>(codec);
  return journal(`signal(${name})`, (env) =>
    adapt(env.ctx.signal<unknown>(name, serde))
  );
}

/** Wait for another invocation's result. */
export function attach<S extends AnySchema>(
  invocationId: restate.InvocationId,
  codec: S
): Effect.Effect<SchemaType<S>, RestateFailure, RestateContext>;
export function attach<T = unknown>(
  invocationId: restate.InvocationId
): Effect.Effect<T, RestateFailure, RestateContext>;
export function attach(
  invocationId: restate.InvocationId,
  codec?: AnySchema
): Effect.Effect<unknown, RestateFailure, RestateContext> {
  const serde = toSerde<unknown>(codec);
  return journal(`attach(${invocationId})`, (env) =>
    adapt(env.ctx.attach<unknown>(invocationId, serde))
  );
}

/** Cancel another invocation. */
export function cancel(
  invocationId: restate.InvocationId
): Effect.Effect<void, never, RestateContext> {
  return syncJournal(`cancel(${invocationId})`, (env) => {
    env.ctx.cancel(invocationId);
  });
}

// ---------------------------------------------------------------------------
// workflow durable promises
// ---------------------------------------------------------------------------

/** A workflow-scoped durable promise, shared by the workflow's handlers. */
export interface WorkflowPromise<T> {
  /** Waits for the promise; suspends the invocation until it is completed. */
  readonly result: Effect.Effect<T, RestateFailure, RestateContext>;
  /** The value if already completed, `undefined` otherwise. */
  readonly peek: Effect.Effect<T | undefined, RestateFailure, RestateContext>;
  /** Complete the promise with a value. */
  resolve(value: T): Effect.Effect<void, RestateFailure, RestateContext>;
  /** Complete the promise with a terminal failure. */
  reject(reason: string): Effect.Effect<void, RestateFailure, RestateContext>;
}

/**
 * A durable promise bound to this workflow, addressable by name from the
 * workflow's `run` handler and from its shared handlers.
 */
export function workflowPromise<S extends AnySchema>(
  name: string,
  codec: S
): Effect.Effect<
  WorkflowPromise<SchemaType<S>>,
  never,
  RestateContext | DurablePromise
>;
export function workflowPromise<T = unknown>(
  name: string
): Effect.Effect<WorkflowPromise<T>, never, RestateContext | DurablePromise>;
export function workflowPromise(
  name: string,
  codec?: AnySchema
): Effect.Effect<
  WorkflowPromise<unknown>,
  never,
  RestateContext | DurablePromise
> {
  type T = unknown;
  const serde = toSerde<T>(codec);
  return contextRead((env) => {
    const promise = (
      env.ctx as unknown as restate.WorkflowSharedContext
    ).promise<T>(name, serde);
    return {
      result: journal(`workflowPromise.get(${name})`, () =>
        adapt(promise.get())
      ),
      peek: journal(`workflowPromise.peek(${name})`, () =>
        adapt(
          // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
          promise.peek() as restate.RestatePromise<T | undefined>
        )
      ),
      resolve: (value: T) =>
        journal(`workflowPromise.resolve(${name})`, () =>
          adapt(promise.resolve(value) as restate.RestatePromise<void>)
        ),
      reject: (reason: string) =>
        journal(`workflowPromise.reject(${name})`, () =>
          // Restate's durable-promise rejection, not Promise.reject.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          adapt(promise.reject(reason) as restate.RestatePromise<void>)
        ),
    };
  });
}

// ---------------------------------------------------------------------------
// escape hatch
// ---------------------------------------------------------------------------

/**
 * The raw SDK context of this invocation.
 *
 * The escape hatch for SDK features this package does not wrap yet. Anything
 * you await from it bypasses the driver, so **never await a `RestatePromise`
 * directly** — hand it to {@link durable} instead, which registers it as a
 * journal source like every other operation.
 */
export const rawContext: Effect.Effect<restate.Context, never, RestateContext> =
  contextRead((env) => env.ctx);

/**
 * Wrap a `RestatePromise` obtained from {@link rawContext} into a durable
 * effect. The promise must be created *inside* the callback: that is what pins
 * the journal entry to a deterministic position.
 */
export function durable<A>(
  name: string,
  create: (ctx: restate.Context) => restate.RestatePromise<A>
): Effect.Effect<A, RestateFailure, RestateContext> {
  return journal(name, (env) => adapt(create(env.ctx)));
}

/** Never use directly — exported for `client.ts`. @internal */
export const internalWithInvocation = withInvocation;

/** Codec argument accepted anywhere a value crosses the journal. */
export type Codec<T> = Schema.Codec<T, any> | restate.Serde<T>;

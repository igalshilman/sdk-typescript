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

// Services and capability markers that appear in a handler's `R`.
// =============================================================================
//
// `RestateContext` is the invocation itself. The remaining keys are *markers*:
// they carry no useful shape, they exist so that an operation which is illegal
// for a given handler kind is a compile error rather than a runtime one. Each
// handler kind provides exactly the markers it is allowed to use:
//
//   service handler          RestateContext
//   object handler           RestateContext, ObjectKey, StateRead, StateWrite
//   object shared handler    RestateContext, ObjectKey, StateRead
//   workflow `run` handler   RestateContext, ObjectKey, StateRead, StateWrite,
//                            DurablePromise
//   workflow shared handler  RestateContext, ObjectKey, StateRead,
//                            DurablePromise

import { Context, type Effect } from "effect";
import type * as restate from "@restatedev/restate-sdk";
import type { Awaitable } from "./internal/lib.js";

/**
 * What the journal multiplexer offers the durable operations. Implemented by
 * the driver; described here as an interface so the driver itself stays
 * internal.
 */
export interface InvocationDriver {
  /** Aborts on invocation cancellation and on attempt end. */
  readonly abortSignal: AbortSignal;
  /** Announce a journal op before creating it (unjournaled-async detector). */
  enterJournalOp(op: string): void;
  /**
   * Create a durable operation and park the calling fiber on it.
   *
   * `onInterrupt` runs if the parked fiber is interrupted before the operation
   * settles — a race loser, a timeout, an enclosing scope closing. The journal
   * entry itself is already created and will still be completed by Restate;
   * this is for the *external* work behind it, which is why `Restate.run` uses
   * it to abort its closure's `AbortSignal`.
   */
  park<A>(
    op: string,
    create: () => Awaitable<A>,
    onInterrupt?: () => void
  ): Effect.Effect<A, unknown, never>;
}

/** Which capability markers a handler kind gets. */
export type HandlerKind =
  | "service"
  | "object"
  | "objectShared"
  | "workflow"
  | "workflowShared";

/**
 * The invocation's ambient state. Public because it is the shape of the
 * `RestateContext` service, which appears in handler `R` types; the fields are
 * internal and may change.
 */
export interface RestateInvocation {
  /** The underlying SDK context of this invocation. */
  readonly ctx: restate.internal.ContextInternal;
  /**
   * The kind of handler being invoked. Notably tells the keyed kinds — whose
   * context has a `key` — from a plain service, whose `key` getter throws.
   */
  readonly kind: HandlerKind;
  /** The journal multiplexer driving this invocation. */
  readonly driver: InvocationDriver;
  /**
   * The application services, without this invocation's overrides. `Restate.run`
   * closures execute against these — real clock, real scheduler.
   */
  readonly appContext: Context.Context<never>;
  /** Wall-clock reading frozen at attempt entry; log timestamps only. */
  readonly attemptStartMillis: number;
}

/**
 * The Restate invocation, required by every durable operation.
 *
 * Provided by the handler boundary — never provide it yourself, and never let
 * it escape into an effect that runs outside a handler.
 */
export const RestateContext: Context.Service<
  RestateInvocation,
  RestateInvocation
> = Context.Service<RestateInvocation>(
  "@restatedev/restate-sdk-effect/RestateContext"
);
/** The capability every durable operation requires. */
export type RestateContext = RestateInvocation;

/** Marker: this handler may read virtual-object / workflow state. */
export const StateRead: Context.Service<StateRead, StateRead> =
  Context.Service<StateRead>("@restatedev/restate-sdk-effect/StateRead");
/** Marker type for reading state. */
export interface StateRead {
  readonly _capability: "StateRead";
}

/** Marker: this handler may write virtual-object / workflow state. */
export const StateWrite: Context.Service<StateWrite, StateWrite> =
  Context.Service<StateWrite>("@restatedev/restate-sdk-effect/StateWrite");
/** Marker type for writing state. */
export interface StateWrite {
  readonly _capability: "StateWrite";
}

/** Marker: this handler may use workflow durable promises. */
export const DurablePromise: Context.Service<DurablePromise, DurablePromise> =
  Context.Service<DurablePromise>(
    "@restatedev/restate-sdk-effect/DurablePromise"
  );
/** Marker type for workflow durable promises. */
export interface DurablePromise {
  readonly _capability: "DurablePromise";
}

/** Marker: this handler belongs to a keyed service, so it has a key. */
export const ObjectKey: Context.Service<ObjectKey, ObjectKey> =
  Context.Service<ObjectKey>("@restatedev/restate-sdk-effect/ObjectKey");
/** Marker type for the object / workflow key. */
export interface ObjectKey {
  readonly _capability: "ObjectKey";
}

/**
 * The `AbortSignal` of the surrounding `restate.run`, available *inside* a run
 * closure — pass it to AbortSignal-aware APIs (`fetch(url, { signal })`) so
 * in-flight work stops promptly when the invocation is cancelled or the attempt
 * ends.
 *
 * ```ts
 * yield* restate.run("fetch", Effect.gen(function* () {
 *   const { signal } = yield* restate.RunSignal;
 *   return yield* Effect.promise(() => fetch(url, { signal }).then((r) => r.json()));
 * }));
 * ```
 */
export const RunSignal: Context.Service<RunSignal, RunSignal> =
  Context.Service<RunSignal>("@restatedev/restate-sdk-effect/RunSignal");
/** Shape of {@link RunSignal}. */
export interface RunSignal {
  readonly signal: AbortSignal;
}

/** Every capability provided by the handler boundary. */
export type RestateCapability =
  | RestateContext
  | StateRead
  | StateWrite
  | DurablePromise
  | ObjectKey;

/** @internal */
export const markers = {
  stateRead: { _capability: "StateRead" } as StateRead,
  stateWrite: { _capability: "StateWrite" } as StateWrite,
  durablePromise: { _capability: "DurablePromise" } as DurablePromise,
  objectKey: { _capability: "ObjectKey" } as ObjectKey,
} as const;

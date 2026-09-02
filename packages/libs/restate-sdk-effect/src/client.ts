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

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

// Typed RPC between services.
// =============================================================================
//
// Clients are built from `@restatedev/restate-sdk-core` descriptors — the same
// contracts the promise SDK and `restate-sdk-gen` use — so an Effect service
// calls and is called by services written with any of them.
//
// A call is an ordinary journal source: it parks the calling fiber, and several
// calls in flight concurrently are raced through the journal like any other
// durable operation.

import { Effect, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk";
import type {
  Descriptor,
  HandlerDescriptor,
} from "@restatedev/restate-sdk-core";
import type { RestateContext } from "./context.js";
import { RestateFailure } from "./errors.js";
import { adapt } from "./internal/default-lib.js";
import { contextRead, journal, syncJournal } from "./internal/journal.js";
import { type AnySchema, type SchemaType, toSerde } from "./serde.js";

/** Options for a request-response call. */
export type CallOptions = {
  /** Idempotency key for the callee's invocation. */
  readonly idempotencyKey?: string;
  /** Concurrency-limit key; only valid inside a scope. */
  readonly limitKey?: string;
  /** Extra headers to attach to the request. */
  readonly headers?: Record<string, string>;
  /** Journal entry name, for observability. */
  readonly name?: string;
};

/** Options for a one-way send. */
export type SendOptions = CallOptions & {
  /** Delay before the callee is invoked. */
  readonly delay?: restate.Duration | number;
};

/** Handle on a one-way send. */
export interface InvocationHandle {
  /** The callee's invocation id — itself a durable operation. */
  readonly invocationId: Effect.Effect<
    restate.InvocationId,
    RestateFailure,
    RestateContext
  >;
}

/** A request-response client over a service contract. */
export type Client<H extends Record<string, HandlerDescriptor>> = {
  readonly [K in keyof H]: H[K] extends HandlerDescriptor<infer I, infer O>
    ? [I] extends [void]
      ? (
          input?: undefined,
          options?: CallOptions
        ) => Effect.Effect<O, RestateFailure, RestateContext>
      : (
          input: I,
          options?: CallOptions
        ) => Effect.Effect<O, RestateFailure, RestateContext>
    : never;
};

/** A fire-and-forget client over a service contract. */
export type SendClient<H extends Record<string, HandlerDescriptor>> = {
  readonly [K in keyof H]: H[K] extends HandlerDescriptor<infer I, any>
    ? [I] extends [void]
      ? (
          input?: undefined,
          options?: SendOptions
        ) => Effect.Effect<InvocationHandle, never, RestateContext>
      : (
          input: I,
          options?: SendOptions
        ) => Effect.Effect<InvocationHandle, never, RestateContext>
    : never;
};

/**
 * A typed request-response client.
 *
 * ```ts
 * const Greeter = restate.iface.service("greeter", { greet: ... });
 * const greeting = yield* restate.client(Greeter).greet("world");
 * const total = yield* restate.client(Cart, cartId).total();
 * ```
 */
export function client<H extends Record<string, HandlerDescriptor>>(
  descriptor: Descriptor<string, H, "service">
): Client<H>;
export function client<H extends Record<string, HandlerDescriptor>>(
  descriptor: Descriptor<string, H, "object" | "workflow">,
  key: string
): Client<H>;
export function client(
  descriptor: Descriptor<string, any, any>,
  key?: string
): Client<any> {
  return makeClient(descriptor, key, undefined);
}

function makeClient(
  descriptor: Descriptor<string, any, any>,
  key: string | undefined,
  scope: string | undefined
): Client<any> {
  return new Proxy({} as any, {
    get(_target, method: string) {
      return (...args: unknown[]) => {
        const { input, options } = splitArgs<CallOptions>(args);
        const handler = descriptor._handlers[method] as
          | HandlerDescriptor
          | undefined;
        return journal(
          `call(${descriptor.name}/${method})`,
          (env): ReturnType<typeof adapt<unknown>> =>
            adapt(
              env.ctx.genericCall<unknown, unknown>({
                service: descriptor.name,
                key,
                method,
                parameter: input,
                inputSerde: (handler?._inputSerde ??
                  restate.serde.json) as restate.Serde<unknown>,
                outputSerde: (handler?._outputSerde ??
                  restate.serde.json) as restate.Serde<unknown>,
                idempotencyKey: options?.idempotencyKey,
                limitKey: options?.limitKey,
                scope,
                headers: options?.headers,
                name: options?.name,
              })
            )
        );
      };
    },
  }) as Client<any>;
}

/**
 * A typed one-way client. The send is journaled immediately; the returned
 * handle's `invocationId` is a separate durable operation.
 */
export function sendClient<H extends Record<string, HandlerDescriptor>>(
  descriptor: Descriptor<string, H, "service">
): SendClient<H>;
export function sendClient<H extends Record<string, HandlerDescriptor>>(
  descriptor: Descriptor<string, H, "object" | "workflow">,
  key: string
): SendClient<H>;
export function sendClient(
  descriptor: Descriptor<string, any, any>,
  key?: string
): SendClient<any> {
  return makeSendClient(descriptor, key, undefined);
}

function makeSendClient(
  descriptor: Descriptor<string, any, any>,
  key: string | undefined,
  scope: string | undefined
): SendClient<any> {
  return new Proxy({} as any, {
    get(_target, method: string) {
      return (...args: unknown[]) => {
        const { input, options } = splitArgs<SendOptions>(args);
        const handler = descriptor._handlers[method] as
          | HandlerDescriptor
          | undefined;
        return syncJournal(
          `send(${descriptor.name}/${method})`,
          (env): InvocationHandle => {
            const handle = env.ctx.genericSend<unknown>({
              service: descriptor.name,
              key,
              method,
              parameter: input,
              inputSerde: (handler?._inputSerde ??
                restate.serde.json) as restate.Serde<unknown>,
              delay: options?.delay,
              idempotencyKey: options?.idempotencyKey,
              limitKey: options?.limitKey,
              scope,
              headers: options?.headers,
              name: options?.name,
            });
            return {
              invocationId: journal(
                `send.invocationId(${descriptor.name}/${method})`,
                () =>
                  adapt(
                    handle.invocationId as unknown as restate.RestatePromise<restate.InvocationId>
                  )
              ),
            };
          }
        );
      };
    },
  }) as SendClient<any>;
}

/**
 * Route calls and sends through a named scope: a sub-grouping of resources
 * within the cluster that becomes part of the target identity.
 *
 * ```ts
 * yield* restate.scope("tenant-123").client(Greeter).greet(name);
 * ```
 */
export function scope(scopeKey: string): {
  client: typeof client;
  sendClient: typeof sendClient;
} {
  return {
    client: ((descriptor: Descriptor<string, any, any>, key?: string) =>
      makeClient(descriptor, key, scopeKey)) as typeof client,
    sendClient: ((descriptor: Descriptor<string, any, any>, key?: string) =>
      makeSendClient(descriptor, key, scopeKey)) as typeof sendClient,
  };
}

/**
 * Decode a callee's declared domain error back into a tagged error.
 *
 * A service written with this SDK encodes its declared failures into the
 * terminal error's body (DESIGN §7); this operator turns that body back into a
 * typed failure so `Effect.catchTag` works across a service boundary. Failures
 * that do not match `codec` — infrastructure failures, cancellation, errors
 * from services with a different error contract — stay `RestateFailure`.
 *
 * ```ts
 * const greeting = yield* restate.client(Greeter).greet("").pipe(
 *   restate.decodeFailure(EmptyName),
 *   Effect.catchTag("EmptyName", () => Effect.succeed("hello, stranger"))
 * );
 * ```
 */
export function decodeFailure<S extends AnySchema>(
  codec: S
): <A, R>(
  self: Effect.Effect<A, RestateFailure, R>
) => Effect.Effect<A, SchemaType<S> | RestateFailure, R> {
  const decode = Schema.decodeUnknownSync(codec);
  return <A, R>(self: Effect.Effect<A, RestateFailure, R>) =>
    Effect.catch(self, (failure: RestateFailure) => {
      let body: unknown;
      try {
        body = JSON.parse(failure.message);
      } catch {
        return Effect.fail(failure);
      }
      try {
        return Effect.fail(decode(body) as SchemaType<S>);
      } catch {
        return Effect.fail(failure);
      }
    });
}

/**
 * The invocation id of an in-flight call — unused for now, kept for symmetry
 * with `sendClient`. @internal
 */
export const currentInvocationId: Effect.Effect<string, never, RestateContext> =
  contextRead((env) => env.ctx.request().id);

// ---------------------------------------------------------------------------
// untyped call / send
// ---------------------------------------------------------------------------

/** A call addressed by service and handler name, without a contract. */
export type CallRequest<REQ, RES> = {
  /** Target service name. */
  readonly service: string;
  /** Target handler name. */
  readonly method: string;
  /** Target key, for a virtual object or workflow. */
  readonly key?: string;
  /** The request payload. */
  readonly parameter: REQ;
  /** Codec for the payload. Defaults to JSON. */
  readonly inputSerde?: restate.Serde<REQ>;
  /** Codec for the response. Defaults to JSON. */
  readonly outputSerde?: restate.Serde<RES>;
  /** Idempotency key for the callee's invocation. */
  readonly idempotencyKey?: string;
  /** Extra request headers. */
  readonly headers?: Record<string, string>;
  /** Journal entry name, for observability. */
  readonly name?: string;
  /** Cluster scope to route through. */
  readonly scope?: string;
  /** Concurrency-limit key; only valid inside a scope. */
  readonly limitKey?: string;
};

/** A one-way send addressed by service and handler name. */
export type SendRequest<REQ> = Omit<
  CallRequest<REQ, unknown>,
  "outputSerde"
> & {
  /** Delay before the callee is invoked. */
  readonly delay?: restate.Duration | number;
};

/**
 * Call a handler by name, when there is no contract to import — a proxy, a
 * dispatcher, a service discovered at runtime. Prefer {@link client}.
 */
export function call<REQ = unknown, RES = unknown>(
  request: CallRequest<REQ, RES>
): Effect.Effect<RES, RestateFailure, RestateContext> {
  return journal(`call(${request.service}/${request.method})`, (env) =>
    adapt(
      env.ctx.genericCall<REQ, RES>({
        service: request.service,
        method: request.method,
        key: request.key,
        parameter: request.parameter,
        inputSerde: (request.inputSerde ??
          restate.serde.json) as restate.Serde<REQ>,
        outputSerde: (request.outputSerde ??
          restate.serde.json) as restate.Serde<RES>,
        idempotencyKey: request.idempotencyKey,
        headers: request.headers,
        name: request.name,
        scope: request.scope,
        limitKey: request.limitKey,
      })
    )
  );
}

/**
 * Create a call's journal entry without waiting for its result.
 *
 * The callee is invoked and its result is recorded in the journal, but this
 * invocation never reads it. Use it when the *call* semantics matter (the
 * callee's failure should be visible to Restate, the invocation id is
 * addressable) but the result does not; for plain fire-and-forget, {@link send}
 * is cheaper.
 */
export function callDetached<REQ = unknown, RES = unknown>(
  request: CallRequest<REQ, RES>
): Effect.Effect<void, never, RestateContext> {
  return syncJournal(
    `callDetached(${request.service}/${request.method})`,
    (env) => {
      // The result is deliberately not awaited: the entry is what matters.
      void env.ctx.genericCall<REQ, RES>({
        service: request.service,
        method: request.method,
        key: request.key,
        parameter: request.parameter,
        inputSerde: (request.inputSerde ??
          restate.serde.json) as restate.Serde<REQ>,
        outputSerde: (request.outputSerde ??
          restate.serde.json) as restate.Serde<RES>,
        idempotencyKey: request.idempotencyKey,
        headers: request.headers,
        name: request.name,
        scope: request.scope,
        limitKey: request.limitKey,
      });
    }
  );
}

/** Send to a handler by name, without waiting for its result. */
export function send<REQ = unknown>(
  request: SendRequest<REQ>
): Effect.Effect<InvocationHandle, never, RestateContext> {
  return syncJournal(
    `send(${request.service}/${request.method})`,
    (env): InvocationHandle => {
      const handle = env.ctx.genericSend<REQ>({
        service: request.service,
        method: request.method,
        key: request.key,
        parameter: request.parameter,
        inputSerde: (request.inputSerde ??
          restate.serde.json) as restate.Serde<REQ>,
        idempotencyKey: request.idempotencyKey,
        headers: request.headers,
        name: request.name,
        delay: request.delay,
        scope: request.scope,
        limitKey: request.limitKey,
      });
      return {
        invocationId: journal(
          `send.invocationId(${request.service}/${request.method})`,
          () =>
            adapt(
              handle.invocationId as unknown as restate.RestatePromise<restate.InvocationId>
            )
        ),
      };
    }
  );
}

/** A named signal on another invocation. */
export interface SignalHandle<T> {
  /** Complete the signal with a value. */
  resolve(value: T): Effect.Effect<void, never, RestateContext>;
  /** Complete the signal with a failure. */
  reject(reason: string): Effect.Effect<void, never, RestateContext>;
}

/** A handle on another invocation. */
export interface InvocationRef {
  /** Address one of its named signals. */
  signal<S extends AnySchema>(
    name: string,
    codec: S
  ): SignalHandle<SchemaType<S>>;
  /** Address a signal whose payload is plain JSON. */
  signal<T = unknown>(name: string): SignalHandle<T>;
}

/**
 * Address another invocation by id, to complete one of its signals:
 *
 * ```ts
 * yield* restate.invocation(id).signal("approved", Schema.Boolean).resolve(true);
 * ```
 */
export function invocation(invocationId: string): InvocationRef {
  const handle = <T>(name: string, codec?: AnySchema): SignalHandle<T> => ({
    resolve: (value: T) =>
      syncJournal(`signal.resolve(${invocationId}/${name})`, (env) => {
        env.ctx
          .invocation(invocationId as restate.InvocationId)
          .signal<T>(name, toSerde<T>(codec))
          .resolve(value);
      }),
    reject: (reason: string) =>
      syncJournal(`signal.reject(${invocationId}/${name})`, (env) => {
        env.ctx
          .invocation(invocationId as restate.InvocationId)
          .signal<T>(name, toSerde<T>(codec))
          .reject(reason);
      }),
  });
  return {
    signal: (<S extends AnySchema>(name: string, codec?: S) =>
      handle<SchemaType<S>>(name, codec)) as InvocationRef["signal"],
  };
}

/**
 * Split a client call's arguments into input and options, **positionally**.
 *
 * Position 0 is always the input, never options — including for a void-input
 * handler, whose client signature is `(input?: undefined, options?)` precisely
 * so that `ping(opts)` is a compile error rather than a request whose body is
 * the options object. Never discriminate on object shape here: a legitimate
 * request body can look exactly like `CallOptions`.
 */
function splitArgs<O>(args: unknown[]): {
  input: unknown;
  options: O | undefined;
} {
  switch (args.length) {
    case 0:
      return { input: undefined, options: undefined };
    case 1:
      return { input: args[0], options: undefined };
    default:
      return { input: args[0], options: args[1] as O };
  }
}

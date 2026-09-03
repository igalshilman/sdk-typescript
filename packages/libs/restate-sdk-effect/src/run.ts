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

// Activities — the one door between the deterministic world and reality.
// =============================================================================
//
// `activity(name, options)` is the Effect-native, pipeable boundary. Inside the
// wrapped effect anything goes: real timers, real I/O, the real scheduler. It
// executes on the *application* runtime, and only its journaled outcome
// re-enters the deterministic runtime (DESIGN §5, rule 1).
//
// Typed failures are encoded as values inside the run entry, then restored to
// Effect's error channel. Restate therefore owns retries of defects (technical
// failures); Effect operators own retries of typed failures (domain policy).
// `run(name, effect)` remains the lower-level, success-only form.

import { Cause, Context, Effect, Exit, type Schema } from "effect";
import * as restate from "@restatedev/restate-sdk";
import {
  RunSignal,
  type RestateCapability,
  type RestateContext,
} from "./context.js";
import { type RestateFailure } from "./errors.js";
import { journalWithCleanup } from "./internal/journal.js";
import { adapt } from "./internal/default-lib.js";
import { linkAbortController } from "./internal/abort.js";
import type { Codec } from "./ops.js";
import { toSerde } from "./serde.js";

declare const RestateOpsInsideRun: unique symbol;
declare const RestateOpsInsideActivity: unique symbol;

/**
 * Phantom requirement produced when a `run` closure uses Restate operations.
 * It can never be provided, so the mistake is a compile error: journal ops
 * inside a `run` closure would create entries the driver cannot see.
 */
export interface RestateOperationsAreNotAllowedInsideRun {
  readonly [RestateOpsInsideRun]: never;
}

/** Compile-time diagnostic for nested journal operations in an activity. */
export interface RestateOperationsAreNotAllowedInsideActivity {
  readonly [RestateOpsInsideActivity]: never;
}

/**
 * `R`, or a poisoned `R` when the closure requires Restate capabilities.
 *
 * `RunSignal` is scrubbed: `run` provides it to the closure itself.
 */
export type RunRequirements<R> = [Extract<R, RestateCapability>] extends [never]
  ? Exclude<R, RunSignal>
  : Exclude<R, RunSignal> | RestateOperationsAreNotAllowedInsideRun;

/** Requirements of an activity after its runtime services are provided. */
export type ActivityRequirements<R> = [Extract<R, RestateCapability>] extends [
  never,
]
  ? Exclude<R, RunSignal>
  : Exclude<R, RunSignal> | RestateOperationsAreNotAllowedInsideActivity;

/** Retry policy for a durable step. Restate's defaults apply when omitted. */
export type RetryOptions = {
  /** Max attempts including the first. Giving up produces a terminal failure. */
  readonly maxAttempts?: number;
  /** Max total retry duration; milliseconds when a number. */
  readonly maxDuration?: restate.Duration | number;
  /** First retry delay; milliseconds when a number. */
  readonly initialInterval?: restate.Duration | number;
  /** Cap on the retry delay; milliseconds when a number. */
  readonly maxInterval?: restate.Duration | number;
  /** Backoff multiplier applied to the interval between attempts. */
  readonly exponentiationFactor?: number;
};

export type RunOptions<A> = {
  /** Codec for the journaled value. Defaults to JSON. */
  readonly codec?: Schema.Codec<A, any> | restate.Serde<A>;
  /** Retry policy for this step. */
  readonly retry?: RetryOptions;
};

/** Options for a pipeable external activity. */
export type ActivityOptions<A, E = never> = {
  /** Codec for the successful result. Defaults to JSON. */
  readonly result?: Codec<A>;
  /**
   * Codec for a typed failure. Required by the overloads when the wrapped
   * effect can fail in its typed error channel.
   */
  readonly error?: Codec<E>;
  /** Restate-owned retry policy for defects raised by the activity. */
  readonly retry?: RetryOptions;
};

type ActivityOutcome<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E };

type ActivityEffect<A, E, R> = Effect.Effect<
  A,
  E | RestateFailure,
  RestateContext | ActivityRequirements<R>
>;

/**
 * Turn an arbitrary external Effect into a Restate-journaled activity.
 *
 * The wrapped effect is lazy and runs on the application runtime. Its success
 * and typed failure are both journaled, so replay restores the same outcome.
 * A defect is deliberately *not* captured: it rejects the underlying
 * `ctx.run`, delegating technical retry to Restate. A typed failure is restored
 * to Effect's error channel, where `Effect.retry` can implement durable domain
 * retry.
 *
 * ```ts
 * const receipt = yield* charge(order).pipe(
 *   restate.activity("charge", {
 *     result: Receipt,
 *     error: ChargeError,
 *   }),
 *   Effect.retry({
 *     times: 2,
 *     while: (error) => error instanceof ChargeError,
 *   })
 * );
 * ```
 */
export function activity<A, E>(
  name: string,
  options: ActivityOptions<A, E> & {
    readonly result: Codec<A>;
    readonly error: Codec<E>;
  }
): <R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<
  A,
  E | RestateFailure,
  RestateContext | ActivityRequirements<R>
>;
/** A typed-failure activity whose successful result uses JSON. */
export function activity<E>(
  name: string,
  options: Omit<ActivityOptions<unknown, E>, "result" | "error"> & {
    readonly error: Codec<E>;
  }
): <A, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<
  A,
  E | RestateFailure,
  RestateContext | ActivityRequirements<R>
>;
/** An infallible activity with an explicit result codec. */
export function activity<A>(
  name: string,
  options: Omit<ActivityOptions<A>, "error"> & {
    readonly result: Codec<A>;
  }
): <R>(
  effect: Effect.Effect<A, never, R>
) => Effect.Effect<A, RestateFailure, RestateContext | ActivityRequirements<R>>;
/** An infallible activity whose result uses JSON. */
export function activity(
  name: string,
  options?: Pick<ActivityOptions<unknown>, "retry">
): <A, R>(
  effect: Effect.Effect<A, never, R>
) => Effect.Effect<A, RestateFailure, RestateContext | ActivityRequirements<R>>;
export function activity(
  name: string,
  options: ActivityOptions<any, any> = {}
): <A, E, R>(effect: Effect.Effect<A, E, R>) => ActivityEffect<A, E, R> {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): ActivityEffect<A, E, R> => {
    const captured: Effect.Effect<
      ActivityOutcome<A, E>,
      never,
      R
    > = Effect.match(effect, {
      onFailure: (error): ActivityOutcome<A, E> => ({
        _tag: "Failure",
        error,
      }),
      onSuccess: (value): ActivityOutcome<A, E> => ({
        _tag: "Success",
        value,
      }),
    });

    return Effect.flatMap(
      journalExternal<ActivityOutcome<A, E>, R, ActivityRequirements<R>>(
        name,
        captured,
        {
          codec: activityOutcomeSerde(options.result, options.error),
          retry: options.retry,
        }
      ),
      (outcome) =>
        outcome._tag === "Success"
          ? Effect.succeed(outcome.value)
          : Effect.fail(outcome.error)
    );
  };
}

/**
 * Binary envelope around the independently encoded success / failure value.
 * Keeping the envelope outside the codecs means activities work with Effect
 * Schemas and arbitrary Restate Serdes, including non-JSON ones.
 */
function activityOutcomeSerde<A, E>(
  resultCodec: Codec<A> | undefined,
  errorCodec: Codec<E> | undefined
): restate.Serde<ActivityOutcome<A, E>> {
  const resultSerde = (toSerde(resultCodec) ??
    restate.serde.json) as restate.Serde<A>;
  const errorSerde = (toSerde(errorCodec) ??
    restate.serde.json) as restate.Serde<E>;

  return {
    contentType: "application/octet-stream",
    serialize(outcome): Uint8Array {
      const success = outcome._tag === "Success";
      const payload = success
        ? resultSerde.serialize(outcome.value)
        : errorSerde.serialize(outcome.error);
      const encoded = new Uint8Array(payload.length + 1);
      encoded[0] = success ? 0 : 1;
      encoded.set(payload, 1);
      return encoded;
    },
    deserialize(encoded): ActivityOutcome<A, E> {
      if (encoded.length === 0) {
        throw new TypeError("Invalid empty Restate activity outcome");
      }
      const payload = encoded.subarray(1);
      switch (encoded[0]) {
        case 0:
          return { _tag: "Success", value: resultSerde.deserialize(payload) };
        case 1:
          return { _tag: "Failure", error: errorSerde.deserialize(payload) };
        default:
          throw new TypeError(
            `Invalid Restate activity outcome tag: ${String(encoded[0])}`
          );
      }
    },
  };
}

/**
 * Journal `effect` as one durable step named `name`.
 *
 * On replay the step is not re-executed: its recorded result is served from the
 * journal. The step's name is for observability; its journal position is what
 * identifies it, so the *order* of `run` calls must be deterministic — which is
 * exactly what this SDK guarantees, even under concurrency.
 *
 * ```ts
 * const id = yield* restate.run("gen-id", Effect.sync(() => crypto.randomUUID()));
 * ```
 */
export function run<A, R>(
  name: string,
  effect: Effect.Effect<A, never, R>,
  options?: RunOptions<A>
): Effect.Effect<A, RestateFailure, RestateContext | RunRequirements<R>> {
  return journalExternal<A, R, RunRequirements<R>>(name, effect, options);
}

/** Shared runtime boundary; the third parameter supplies the public diagnostic. */
function journalExternal<A, R, Requirements>(
  name: string,
  effect: Effect.Effect<A, never, R>,
  options?: RunOptions<A>
): Effect.Effect<A, RestateFailure, RestateContext | Requirements> {
  return journalWithCleanup(`run(${name})`, (env) => {
    // A child of the driver's current signal: invocation cancellation and
    // attempt end cascade in, while interrupting one fiber aborts only its own
    // in-flight work.
    const controller = linkAbortController(env.driver.abortSignal);
    const signal = controller.signal;
    const action = async (): Promise<A> => {
      const exit = await Effect.runPromiseExitWith(
        Context.add(env.appContext, RunSignal, { signal })
      )(effect as Effect.Effect<A, never, never>, { signal });
      if (Exit.isSuccess(exit)) return exit.value;
      // If the signal fired, the step was cancelled: record the cancellation
      // terminally rather than letting Restate retry a cancelled invocation.
      if (signal.aborted) throw asTerminalError(signal.reason);
      const defect: unknown = Cause.squash(exit.cause);
      throw defect instanceof Error ? defect : new Error(String(defect));
    };
    return {
      awaitable: adapt(env.ctx.run(name, action, toSdkRunOptions(options))),
      // The awaiting fiber lost a race, timed out, or its scope closed. The
      // journal entry stays and Restate still completes it — recording this
      // step as terminally cancelled — but the closure's own work stops now.
      // Nothing reads that entry: the race winner is journaled, so replay
      // resolves to the same winner and interrupts the same loser.
      onInterrupt: () => controller.abort(new restate.CancelledError()),
    };
  }) as Effect.Effect<A, RestateFailure, RestateContext | Requirements>;
}

function toSdkRunOptions<A>(
  options: RunOptions<A> | undefined
): restate.RunOptions<A> {
  const out: restate.RunOptions<A> = {};
  const serde = toSerde<A>(options?.codec);
  if (serde !== undefined) out.serde = serde;
  const retry = options?.retry;
  if (retry !== undefined) {
    if (retry.maxAttempts !== undefined)
      out.maxRetryAttempts = retry.maxAttempts;
    if (retry.maxDuration !== undefined)
      out.maxRetryDuration = retry.maxDuration;
    if (retry.initialInterval !== undefined) {
      out.initialRetryInterval = retry.initialInterval;
    }
    if (retry.maxInterval !== undefined)
      out.maxRetryInterval = retry.maxInterval;
    if (retry.exponentiationFactor !== undefined) {
      out.retryIntervalFactor = retry.exponentiationFactor;
    }
  }
  return out;
}

/**
 * Coerce an abort reason into a terminal error. The journal must record a
 * *terminal* outcome for a cancelled step, otherwise Restate would retry work
 * belonging to an invocation that is going away.
 */
function asTerminalError(reason: unknown): restate.TerminalError {
  return reason instanceof restate.TerminalError
    ? reason
    : new restate.CancelledError();
}

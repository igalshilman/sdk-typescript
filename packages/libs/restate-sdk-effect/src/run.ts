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

// `Restate.run` — the one door between the deterministic world and reality.
// =============================================================================
//
// Inside a `run` closure, anything goes: real timers, real I/O, the real
// scheduler. It executes on the *application* runtime, and only its journaled
// result re-enters the deterministic runtime (DESIGN §5, rule 1).
//
// The closure's effect must not fail in a typed way (`Effect<A, never, R>`):
// only a *value* can be journaled. Die inside the step to force an
// infrastructure retry; wrap in `Effect.exit` when you need to observe the step's
// terminal outcome instead of failing on it.

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
import { toSerde } from "./serde.js";

declare const RestateOpsInsideRun: unique symbol;

/**
 * Phantom requirement produced when a `run` closure uses Restate operations.
 * It can never be provided, so the mistake is a compile error: journal ops
 * inside a `run` closure would create entries the driver cannot see.
 */
export interface RestateOperationsAreNotAllowedInsideRun {
  readonly [RestateOpsInsideRun]: never;
}

/**
 * `R`, or a poisoned `R` when the closure requires Restate capabilities.
 *
 * `RunSignal` is scrubbed: `run` provides it to the closure itself.
 */
export type RunRequirements<R> = [Extract<R, RestateCapability>] extends [never]
  ? Exclude<R, RunSignal>
  : Exclude<R, RunSignal> | RestateOperationsAreNotAllowedInsideRun;

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
 *
 * // durable domain-level retry with durable backoff
 * const charged = yield* restate.run("charge", charge(order)).pipe(
 *   Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4 })
 * );
 * ```
 */
export function run<A, R>(
  name: string,
  effect: Effect.Effect<A, never, R>,
  options?: RunOptions<A>
): Effect.Effect<A, RestateFailure, RestateContext | RunRequirements<R>> {
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
  }) as Effect.Effect<A, RestateFailure, RestateContext | RunRequirements<R>>;
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

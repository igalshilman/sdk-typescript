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

// The per-invocation runtime (DESIGN §3.3) and the handler entry point.
// =============================================================================
//
// Each invocation runs the user's effect against the application services plus
// a small set of invocation-scoped overrides:
//
//   Clock    journaled: `currentTimeMillis`/`currentTimeNanos` read `ctx.date`,
//            and `sleep` becomes a durable timer, which is what makes
//            `Effect.sleep`, `Effect.timeout` and `Schedule` delays durable
//            (DESIGN §4)
//   Random   backed by `ctx.rand`, seeded from the invocation id
//   Console  `ctx.console`, which suppresses output during replay
//   Logger   logfmt through that console
//   Scheduler the deterministic scheduler (added by the driver)
//   RestateContext + the capability markers for this handler kind
//
// The application services are built once per process (`ManagedRuntime`) and
// merged in, so an invocation costs one small context, not a layer build.

import {
  Clock,
  Console,
  Context,
  Duration,
  Effect,
  Logger,
  Random,
} from "effect";
import * as restate from "@restatedev/restate-sdk";
import {
  markers,
  RestateContext,
  DurablePromise,
  ObjectKey,
  StateRead,
  StateWrite,
  type HandlerKind,
  type RestateInvocation,
} from "../context.js";
import { throwOrReturn } from "../errors.js";
import type { AppRuntimeSlot } from "./app-runtime.js";
import { adapt, defaultLib } from "./default-lib.js";
import { Driver, UnjournaledAsyncError } from "./driver.js";

export type { HandlerKind } from "../context.js";

const NANOS_PER_MILLI = 1_000_000n;

/**
 * Run `effect` as one invocation and return what the promise SDK expects from a
 * handler: the value, or a throw.
 */
export async function invoke<A, E, R>(params: {
  readonly ctx: restate.Context;
  readonly effect: Effect.Effect<A, E, R>;
  readonly appRuntime: AppRuntimeSlot;
  readonly kind: HandlerKind;
  readonly encodeFailure: (failure: E) => restate.TerminalError;
}): Promise<A> {
  const ctx = params.ctx as restate.internal.ContextInternal;
  // Built once per process; after the first invocation this is already settled.
  const appContext = await params.appRuntime.context();
  const driver = new Driver(defaultLib, {
    parentSignal: ctx.request().attemptCompletedSignal,
  });
  const invocation: RestateInvocation = {
    ctx,
    kind: params.kind,
    driver,
    appContext,
    attemptStartMillis: Date.now(),
  };
  const context = invocationContext(invocation);

  try {
    const exit = await driver.run(
      params.effect as Effect.Effect<A, E, never>,
      context
    );
    return throwOrReturn(exit, params.encodeFailure);
  } catch (e) {
    // A rule-1 violation is a programming bug: retrying replays the same code
    // and fails the same way, so fail terminally with the diagnostic.
    if (e instanceof UnjournaledAsyncError) {
      throw new restate.TerminalError(e.message, { errorCode: 500 });
    }
    // Suspension and attempt-end propagate verbatim: no interruption, no
    // finalizers — the invocation continues in a later attempt.
    throw e;
  }
}

/** Build the invocation-scoped context on top of the application services. */
export function invocationContext(
  invocation: RestateInvocation
): Context.Context<never> {
  const kind: HandlerKind = invocation.kind;
  let context = invocation.appContext.pipe(
    Context.add(RestateContext, invocation),
    Context.add(Clock.Clock, journaledClock(invocation)),
    Context.add(Random.Random, journaledRandom(invocation)),
    Context.add(Console.Console, invocation.ctx.console),
    Context.add(
      Logger.CurrentLoggers,
      new Set([Logger.withLeveledConsole(Logger.formatLogFmt)])
    )
  );

  if (kind !== "service") {
    context = Context.add(context, ObjectKey, markers.objectKey);
    context = Context.add(context, StateRead, markers.stateRead);
  }
  if (kind === "object" || kind === "workflow") {
    context = Context.add(context, StateWrite, markers.stateWrite);
  }
  if (kind === "workflow" || kind === "workflowShared") {
    context = Context.add(context, DurablePromise, markers.durablePromise);
  }
  return context as Context.Context<never>;
}

/**
 * The journaled `Clock`.
 *
 * Asynchronous reads go through `ctx.date` — journaled, so a replay sees the
 * time the first execution saw. The *synchronous* reads cannot be journaled
 * (nothing can await inside them); they serve a base frozen at attempt entry
 * and exist for log timestamps.
 *
 * Not every Effect operator uses the effectful reads: `Effect.timed`,
 * `Schedule.toStepWithMetadata`, `Cache`, `ScopedCache`, `Pool`, `RcMap` and
 * several `Stream` operators read the clock *unsafely* in 4.0.0-rc.112, so they
 * see the frozen base and measure zero elapsed time. `SHARP-EDGES.md` records
 * which time-sensitive operators are supported; anything semantic must go
 * through `Clock.currentTimeMillis` or a durable timer.
 */
function journaledClock(invocation: RestateInvocation): Clock.Clock {
  const { ctx, driver } = invocation;
  const frozenMillis = invocation.attemptStartMillis;
  const now = (): Effect.Effect<number> =>
    dieOnJournalFailure(
      driver.park("date.now()", () =>
        adapt(ctx.date.now() as restate.RestatePromise<number>)
      )
    );
  const nanos = (): Effect.Effect<bigint> =>
    Effect.map(now(), (millis) => BigInt(Math.trunc(millis)) * NANOS_PER_MILLI);

  return {
    currentTimeMillisUnsafe: () => frozenMillis,
    currentTimeNanosUnsafe: () => BigInt(frozenMillis) * NANOS_PER_MILLI,
    monotonicTimeNanosUnsafe: () => BigInt(frozenMillis) * NANOS_PER_MILLI,
    get currentTimeMillis() {
      return now();
    },
    get currentTimeNanos() {
      return nanos();
    },
    get monotonicTimeNanos() {
      return nanos();
    },
    sleep: (duration: Duration.Duration): Effect.Effect<void> =>
      dieOnJournalFailure(
        driver.park("sleep()", () =>
          adapt(ctx.sleep(Duration.toMillis(duration)))
        )
      ),
  };
}

/**
 * `Random` backed by `ctx.rand` — seeded from the invocation id, so a replay
 * produces the same sequence given the same consumption order, which the
 * deterministic scheduler guarantees.
 */
function journaledRandom(
  invocation: RestateInvocation
): typeof Random.Random.Service {
  const rand = invocation.ctx.rand;
  return {
    nextDoubleUnsafe: () => rand.random(),
    nextIntUnsafe: () => Math.trunc(rand.random() * 0x1_0000_0000) | 0,
  };
}

/**
 * A journal source failing is not something ambient services can express: the
 * `Clock` has no error channel. Such a failure means the journal itself is in
 * trouble, so it becomes a defect and Restate retries the attempt.
 */
function dieOnJournalFailure<A>(
  effect: Effect.Effect<A, unknown>
): Effect.Effect<A> {
  return Effect.catch(effect, (error: unknown) => Effect.die(error));
}

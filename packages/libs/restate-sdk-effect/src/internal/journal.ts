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

// The single funnel for durable operations.
//
// Every journal op in this package goes through `journal` (parks the fiber) or
// `syncJournal` (creates an entry without waiting). Two things depend on that
// being the only path:
//
//   - journal-entry creation order is fiber-execution order, which the
//     deterministic scheduler fixes (DESIGN §2, fact 1);
//   - the unjournaled-async detector sees every op, which is what makes the
//     check in DESIGN §5 complete.

import { Effect } from "effect";
import { RestateContext, type RestateInvocation } from "../context.js";
import { fromJournalRejection, type RestateFailure } from "../errors.js";
import type { Awaitable } from "./lib.js";

/** The current invocation. */
export const invocation: Effect.Effect<
  RestateInvocation,
  never,
  RestateContext
> = RestateContext;

/** Read the invocation and continue with an effect. */
export function withInvocation<A, E, R>(
  f: (env: RestateInvocation) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | RestateContext> {
  return Effect.flatMap(invocation, f);
}

/**
 * A durable operation that parks the calling fiber until the journal produces
 * its result. `create` runs synchronously inside the fiber's step: that is what
 * pins the entry's position in the journal.
 */
export function journal<A>(
  op: string,
  create: (env: RestateInvocation) => Awaitable<A>
): Effect.Effect<A, RestateFailure, RestateContext> {
  return withInvocation((env) =>
    Effect.catch(
      env.driver.park(op, () => create(env)),
      (error: unknown): Effect.Effect<never, RestateFailure> =>
        fromJournalRejection(error)
    )
  );
}

/**
 * A durable operation that also owns external work, which must stop if the
 * awaiting fiber is interrupted before the operation settles — a race loser, a
 * timeout, a closing scope. `start` returns the awaitable together with the
 * teardown for that particular execution.
 *
 * The teardown is captured *per execution*, not per effect value: `withInvocation`
 * re-runs its callback every time the effect runs, so a retried or concurrently
 * running operation cannot tear down another execution's work.
 */
export function journalWithCleanup<A>(
  op: string,
  start: (env: RestateInvocation) => {
    readonly awaitable: Awaitable<A>;
    readonly onInterrupt: () => void;
  }
): Effect.Effect<A, RestateFailure, RestateContext> {
  return withInvocation((env) => {
    let onInterrupt: (() => void) | undefined;
    return Effect.catch(
      env.driver.park(
        op,
        () => {
          const started = start(env);
          onInterrupt = started.onInterrupt;
          return started.awaitable;
        },
        () => onInterrupt?.()
      ),
      (error: unknown): Effect.Effect<never, RestateFailure> =>
        fromJournalRejection(error)
    );
  });
}

/**
 * A durable operation with no result to wait for — `ctx.set`, `ctx.clear`, a
 * one-way send, resolving an awakeable. It still creates a journal entry, so it
 * still has to be seen by the detector.
 */
export function syncJournal<A>(
  op: string,
  f: (env: RestateInvocation) => A
): Effect.Effect<A, never, RestateContext> {
  return Effect.map(invocation, (env) => {
    env.driver.enterJournalOp(op);
    return f(env);
  });
}

/** Read something off the context without touching the journal. */
export function contextRead<A>(
  f: (env: RestateInvocation) => A
): Effect.Effect<A, never, RestateContext> {
  return Effect.map(invocation, f);
}

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

// The error boundary (DESIGN §7).
// =============================================================================
//
// Three channels leave a handler, and Restate treats them differently:
//
//   declared domain failure  -> TerminalError carrying the Schema-encoded error
//                              (+ `_tag`), not retried; typed clients decode it
//                              back into the tagged error
//   defect                   -> rethrown non-terminal: Restate retries the
//                              attempt (an infrastructure problem, or a bug)
//   interruption             -> CancelledError, not retried
//
// Inside the handler, failures that come *from* Restate (a call that failed
// terminally, retries exhausted on a `run`) arrive as `RestateFailure` — a
// tagged error so `Effect.catchTag` works on it.

import { Cause, Effect, Exit, Option } from "effect";
import * as restate from "@restatedev/restate-sdk";

/**
 * A terminal failure reported by Restate: a durable step whose retries were
 * exhausted, a call whose target failed, a rejected awakeable, a timeout.
 *
 * Terminal means "permanently recorded in the journal": retrying the same
 * operation cannot change this outcome, though a *new* operation (what
 * `Effect.retry` creates) may succeed.
 */
export class RestateFailure extends Error {
  /** Discriminator, so `Effect.catchTag("RestateFailure", …)` works. */
  readonly _tag = "RestateFailure" as const;
  /** Restate error code — an HTTP status code by convention. */
  readonly code: number;
  /** Metadata attached to the terminal error, if any. */
  readonly metadata: Record<string, string>;
  /** The underlying SDK error. */
  readonly terminal: restate.TerminalError;

  constructor(args: {
    readonly message: string;
    readonly code: number;
    readonly metadata: Record<string, string>;
    readonly terminal: restate.TerminalError;
  }) {
    super(args.message);
    this.name = "RestateFailure";
    this.code = args.code;
    this.metadata = args.metadata;
    this.terminal = args.terminal;
  }
}

/** Restate's cancellation code; `CancelledError` carries it. */
const CANCELLED_CODE = 409;
/** Restate's timeout code; `TimeoutError` carries it. */
const TIMEOUT_CODE = 408;

/**
 * True when the invocation was cancelled (code 409).
 *
 * The code is what is checked, not the class: a terminal error that crossed a
 * service boundary is *reconstructed* from the wire, so it carries code 409
 * without being an instance of `CancelledError`. `instanceof` is kept as a
 * second chance in case a future code changes.
 */
export function isCancellation(failure: RestateFailure): boolean {
  return (
    failure.code === CANCELLED_CODE ||
    failure.terminal instanceof restate.CancelledError
  );
}

/** True when a durable timeout elapsed (code 408). Code first, as above. */
export function isTimeout(failure: RestateFailure): boolean {
  return (
    failure.code === TIMEOUT_CODE ||
    failure.terminal instanceof restate.TimeoutError
  );
}

/**
 * Wrap a rejection coming out of the journal.
 *
 * A terminal rejection becomes a typed `RestateFailure` the handler can catch,
 * compensate for, or retry. Anything else is not a deterministic outcome of the
 * operation (it is an SDK or transport problem), so it stays a defect.
 */
export function fromJournalRejection(
  error: unknown
): Effect.Effect<never, RestateFailure> {
  return error instanceof restate.TerminalError
    ? Effect.fail(toRestateFailure(error))
    : Effect.die(error);
}

/** Convert an SDK terminal error into the tagged failure. */
export function toRestateFailure(
  terminal: restate.TerminalError
): RestateFailure {
  return new RestateFailure({
    message: terminal.message,
    code: terminal.code,
    metadata: terminal.metadata ?? {},
    terminal,
  });
}

/**
 * Turn a handler's `Exit` into what the promise SDK expects from a handler
 * function: a value, or a throw.
 *
 * - success -> the value
 * - interruption -> `CancelledError` (Restate does not retry a cancelled
 *   invocation)
 * - declared domain failure -> `TerminalError` produced by `encodeFailure`
 * - `RestateFailure` -> the original terminal error, verbatim, so codes and
 *   metadata propagate to the caller unchanged
 * - defect -> rethrown as-is, which Restate treats as retryable
 */
export function throwOrReturn<A, E>(
  exit: Exit.Exit<A, E>,
  encodeFailure: (failure: E) => restate.TerminalError
): A {
  if (Exit.isSuccess(exit)) return exit.value;

  const cause = exit.cause;
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof RestateFailure) throw error.terminal;
    throw encodeFailure(error);
  }

  // Interruption with no accompanying failure: the invocation was cancelled, or
  // the handler interrupted itself. Report it as cancelled — Restate stops.
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause)) {
    throw new restate.CancelledError();
  }

  const defect: unknown = Cause.squash(cause);
  throw defect instanceof Error ? defect : new Error(Cause.pretty(cause));
}

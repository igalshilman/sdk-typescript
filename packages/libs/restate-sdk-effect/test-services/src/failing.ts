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

import { Effect, Exit } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

// Process-level counters, on purpose: these handlers assert on how many times
// an *attempt* (or a `run` closure) actually executed.
let failures = 0;
let eventualSuccessSideEffects = 0;
let eventualFailureSideEffects = 0;

type FailureToPropagate = {
  errorMessage: string;
  metadata?: Record<string, string>;
};

export const failing = restate.object({
  name: "Failing",
  handlers: {
    terminallyFailingCall: restate.handler({}, (f: FailureToPropagate) =>
      restate.terminalError(f.errorMessage, { metadata: f.metadata })
    ),

    callTerminallyFailingCall: restate.handler({}, (f: FailureToPropagate) =>
      Effect.gen(function* () {
        yield* restate.call<FailureToPropagate, void>({
          service: "Failing",
          method: "terminallyFailingCall",
          key: "random-583e1bf2",
          parameter: f,
        });
        return yield* Effect.die(new Error("Should not reach here"));
      })
    ),

    // A retryable failure: the attempt is retried until the fourth one, which
    // succeeds. Dying (not failing) is what marks it retryable.
    failingCallWithEventualSuccess: restate.handler({}, () =>
      Effect.suspend(() => {
        failures += 1;
        if (failures >= 4) {
          failures = 0;
          return Effect.succeed(4);
        }
        return Effect.die(new Error(`Failed at attempt: ${failures}`));
      })
    ),

    terminallyFailingSideEffect: restate.handler({}, (f: FailureToPropagate) =>
      Effect.gen(function* () {
        yield* restate.run(
          "sideEffect",
          Effect.suspend(() =>
            Effect.die(
              new restate.TerminalError(f.errorMessage, {
                metadata: f.metadata,
              })
            )
          )
        );
        return yield* Effect.die(new Error("Should not reach here"));
      })
    ),

    sideEffectSucceedsAfterGivenAttempts: restate.handler(
      {},
      (minimumAttempts: number) =>
        restate.run(
          "sideEffect",
          Effect.suspend(() => {
            eventualSuccessSideEffects += 1;
            if (eventualSuccessSideEffects < minimumAttempts) {
              return Effect.die(
                new Error(`Failed at attempt: ${eventualSuccessSideEffects}`)
              );
            }
            return Effect.succeed(eventualSuccessSideEffects);
          }),
          {
            retry: {
              maxAttempts: minimumAttempts + 1,
              initialInterval: 1,
              exponentiationFactor: 1.0,
            },
          }
        )
    ),

    sideEffectFailsAfterGivenAttempts: restate.handler(
      {},
      (retryPolicyMaxRetryCount: number) =>
        Effect.gen(function* () {
          const outcome = yield* restate.runExit(
            "sideEffect",
            Effect.suspend(() => {
              eventualFailureSideEffects += 1;
              return Effect.die(
                new Error(`Failed at attempt: ${eventualFailureSideEffects}`)
              );
            }),
            {
              retry: {
                maxAttempts: retryPolicyMaxRetryCount,
                initialInterval: 1,
                exponentiationFactor: 1.0,
              },
            }
          );
          if (Exit.isSuccess(outcome)) {
            return yield* Effect.die(new Error("Side effect did not fail."));
          }
          return eventualFailureSideEffects;
        })
    ),
  },
});

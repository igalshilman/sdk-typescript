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

// The command interpreter: the harness sends a program of combinator commands
// and checks the results. This is where the SDK's concurrency story is
// exercised directly — every command below is an ordinary Effect combinator
// over durable operations.

import { Effect, Exit } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

type AwaitAwakeableOrTimeoutCmd = {
  type: "awaitAwakeableOrTimeout";
  awakeableKey: string;
  timeoutMillis: number;
};
type ResolveAwakeableCmd = {
  type: "resolveAwakeable";
  awakeableKey: string;
  value: string;
};
type RejectAwakeableCmd = {
  type: "rejectAwakeable";
  awakeableKey: string;
  reason: string;
};
type GetEnvVarCmd = { type: "getEnvVariable"; envName: string };
type AwaitOneCmd = { type: "awaitOne"; command: SubCommand };
type AwaitAnyCmd = { type: "awaitAny"; commands: SubCommand[] };
type AwaitAnySuccessfulCmd = {
  type: "awaitAnySuccessful";
  commands: SubCommand[];
};
type AwaitFirstSucceededOrAllFailedCmd = {
  type: "awaitFirstSucceededOrAllFailed";
  commands: SubCommand[];
};
type AwaitFirstCompletedCmd = {
  type: "awaitFirstCompleted";
  commands: SubCommand[];
};
type AwaitAllSucceededOrFirstFailedCmd = {
  type: "awaitAllSucceededOrFirstFailed";
  commands: SubCommand[];
};
type AwaitAllCompletedCmd = {
  type: "awaitAllCompleted";
  commands: SubCommand[];
};

type Command =
  | AwaitAwakeableOrTimeoutCmd
  | ResolveAwakeableCmd
  | RejectAwakeableCmd
  | GetEnvVarCmd
  | AwaitOneCmd
  | AwaitAnyCmd
  | AwaitAnySuccessfulCmd
  | AwaitFirstSucceededOrAllFailedCmd
  | AwaitFirstCompletedCmd
  | AwaitAllSucceededOrFirstFailedCmd
  | AwaitAllCompletedCmd;

type CreateAwakeableSub = { type: "createAwakeable"; awakeableKey: string };
type SleepSub = { type: "sleep"; timeoutMillis: number };
type RunReturnsSub = { type: "runReturns"; value: string };
type RunThrowTerminalSub = {
  type: "runThrowTerminalException";
  reason: string;
};
type CreateSignalSub = { type: "createSignal"; signalName: string };
type SubCommand =
  | CreateAwakeableSub
  | SleepSub
  | RunReturnsSub
  | RunThrowTerminalSub
  | CreateSignalSub;

/** An awaitable sub-command: `string` on success, a terminal failure on error. */
type Sub = Effect.Effect<
  string,
  restate.RestateFailure,
  restate.RestateContext
>;

/**
 * Materialize a sub-command.
 *
 * Two-stage on purpose: the outer effect performs whatever must happen *now*
 * (an awakeable's id has to be stored in state before anyone waits on it), and
 * returns the effect that awaits the result. That keeps journal-entry creation
 * order equal to command order, exactly as the generator SDK's eager futures
 * do.
 */
const createSub = (
  cmd: SubCommand
): Effect.Effect<
  Sub,
  restate.RestateFailure,
  restate.RestateContext | restate.StateWrite
> => {
  switch (cmd.type) {
    case "createAwakeable":
      return Effect.gen(function* () {
        const callback = yield* restate.awakeable<never>();
        yield* restate.state.set(`awk-${cmd.awakeableKey}`, callback.id);
        return callback.result as Sub;
      });
    case "sleep":
      return Effect.succeed(
        Effect.as(Effect.sleep(`${cmd.timeoutMillis} millis`), "sleep")
      );
    case "runReturns":
      return Effect.succeed(
        restate.run(
          "runReturns",
          Effect.as(Effect.sleep("1 millis"), cmd.value)
        )
      );
    case "runThrowTerminalException":
      return Effect.succeed(
        restate.run(
          "run should fail command",
          Effect.die(new restate.TerminalError(cmd.reason))
        )
      );
    case "createSignal":
      return Effect.succeed(restate.signal<string>(cmd.signalName));
  }
};

const createSubs = (
  commands: readonly SubCommand[]
): Effect.Effect<
  Sub[],
  restate.RestateFailure,
  restate.RestateContext | restate.StateWrite
> => Effect.forEach(commands, createSub, { concurrency: 1 });

const awakeableIdFor = (
  awakeableKey: string
): Effect.Effect<
  string,
  restate.RestateFailure,
  restate.RestateContext | restate.StateRead
> =>
  Effect.gen(function* () {
    const id = yield* restate.state.get<string>(`awk-${awakeableKey}`);
    if (!id) {
      return yield* restate.terminalError("No awakeable is registered");
    }
    return id;
  });

const interpret = (
  cmd: Command
): Effect.Effect<
  string,
  restate.RestateFailure,
  restate.RestateContext | restate.StateRead | restate.StateWrite
> => {
  switch (cmd.type) {
    case "awaitAwakeableOrTimeout":
      return Effect.gen(function* () {
        const callback = yield* restate.awakeable<string>();
        yield* restate.state.set(`awk-${cmd.awakeableKey}`, callback.id);
        return yield* Effect.raceFirst(
          callback.result,
          Effect.andThen(
            Effect.sleep(`${cmd.timeoutMillis} millis`),
            restate.terminalError("await-timeout")
          )
        );
      });

    case "resolveAwakeable":
      return Effect.gen(function* () {
        const id = yield* awakeableIdFor(cmd.awakeableKey);
        yield* restate.resolveAwakeable(id, cmd.value);
        return "";
      });

    case "rejectAwakeable":
      return Effect.gen(function* () {
        const id = yield* awakeableIdFor(cmd.awakeableKey);
        yield* restate.rejectAwakeable(id, cmd.reason);
        return "";
      });

    case "getEnvVariable":
      return restate.run(
        "get_env",
        Effect.sync(() => process.env[cmd.envName] ?? "")
      );

    case "awaitOne":
      return Effect.flatMap(createSub(cmd.command), (sub) => sub);

    // First to *settle*, success or failure.
    case "awaitAny":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.raceAllFirst(subs)
      );

    // First to *succeed*; if every one fails, so does the command.
    case "awaitAnySuccessful":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.catch(Effect.raceAll(subs), () =>
          restate.terminalError("All commands failed")
        )
      );

    case "awaitFirstSucceededOrAllFailed":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.raceAll(subs)
      );

    case "awaitFirstCompleted":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.raceAllFirst(subs)
      );

    case "awaitAllSucceededOrFirstFailed":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.map(Effect.all(subs, { concurrency: "unbounded" }), (results) =>
          results.join("|")
        )
      );

    case "awaitAllCompleted":
      return Effect.flatMap(createSubs(cmd.commands), (subs) =>
        Effect.map(
          Effect.all(
            subs.map((sub) => Effect.exit(sub)),
            { concurrency: "unbounded" }
          ),
          (exits) =>
            exits
              .map((exit) =>
                Exit.isSuccess(exit)
                  ? `ok:${exit.value}`
                  : `err:${failureMessage(exit)}`
              )
              .join("|")
        )
      );
  }
};

function failureMessage(
  exit: Exit.Exit<string, restate.RestateFailure>
): string {
  if (Exit.isSuccess(exit)) return "";
  const failure = exit.cause.reasons.find(
    (reason) => reason._tag === "Fail"
  ) as { readonly error?: restate.RestateFailure } | undefined;
  return failure?.error?.message ?? "unknown";
}

export const virtualObjectCommandInterpreter = restate.object({
  name: "VirtualObjectCommandInterpreter",
  handlers: {
    getResults: restate.sharedHandler({}, () =>
      Effect.map(restate.state.get<string[]>("results"), (r) => r ?? [])
    ),

    hasAwakeable: restate.sharedHandler({}, (awakeableKey: string) =>
      Effect.map(
        restate.state.get<string>(`awk-${awakeableKey}`),
        (id) => id != null
      )
    ),

    resolveAwakeable: restate.sharedHandler(
      {},
      (req: { awakeableKey: string; value: string }) =>
        Effect.gen(function* () {
          const id = yield* awakeableIdFor(req.awakeableKey);
          yield* restate.resolveAwakeable(id, req.value);
        })
    ),

    rejectAwakeable: restate.sharedHandler(
      {},
      (req: { awakeableKey: string; reason: string }) =>
        Effect.gen(function* () {
          const id = yield* awakeableIdFor(req.awakeableKey);
          yield* restate.rejectAwakeable(id, req.reason);
        })
    ),

    interpretCommands: restate.handler({}, (req: { commands: Command[] }) =>
      Effect.gen(function* () {
        let result = "";
        for (const cmd of req.commands) {
          result = yield* interpret(cmd);
          const previous =
            (yield* restate.state.get<string[]>("results")) ?? [];
          yield* restate.state.set("results", [...previous, result]);
        }
        return result;
      })
    ),
  },
});

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

// The layered random-program interpreter — effectively a fuzzer over journal
// operations and concurrency, and the highest-value conformance test for this
// SDK. The harness generates programs of commands; each layer of objects can
// call the next, and the awaited results must match what the command declared.

import { Effect, Exit, Fiber } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

const SET_STATE = 1;
const GET_STATE = 2;
const CLEAR_STATE = 3;
const INCREMENT_STATE_COUNTER = 4;
const INCREMENT_STATE_COUNTER_INDIRECTLY = 5;
const SLEEP = 6;
const CALL_SERVICE = 7;
const CALL_SLOW_SERVICE = 8;
const INCREMENT_VIA_DELAYED_CALL = 9;
const SIDE_EFFECT = 10;
const THROWING_SIDE_EFFECT = 11;
const SLOW_SIDE_EFFECT = 12;
const RECOVER_TERMINAL_CALL = 13;
const RECOVER_TERMINAL_MAYBE_UN_AWAITED = 14;
const AWAIT_PROMISE = 15;
const RESOLVE_AWAKEABLE = 16;
const REJECT_AWAKEABLE = 17;
const INCREMENT_STATE_COUNTER_VIA_AWAKEABLE = 18;
const CALL_NEXT_LAYER_OBJECT = 19;

type Cmd = {
  kind: number;
  key?: number;
  duration?: number;
  sleep?: number;
  index?: number;
  program?: { commands: Cmd[] };
};
type Program = { commands: Cmd[] };
type Layer = 0 | 1 | 2;

export const serviceInterpreterHelper = restate.service({
  name: "ServiceInterpreterHelper",
  handlers: {
    ping: restate.handler({}, () => Effect.void),

    echo: restate.handler({}, (param: string) => Effect.succeed(param)),

    echoLater: restate.handler(
      {},
      (req: { sleep: number; parameter: string }) =>
        Effect.as(Effect.sleep(`${req.sleep} millis`), req.parameter)
    ),

    terminalFailure: restate.handler({}, () => restate.terminalError("bye")),

    incrementIndirectly: restate.handler(
      {},
      (param: { layer: Layer; key: string }) =>
        Effect.asVoid(
          restate.rpc.send<Program>({
            service: `ObjectInterpreterL${param.layer}`,
            method: "interpret",
            key: param.key,
            parameter: { commands: [{ kind: INCREMENT_STATE_COUNTER }] },
          })
        )
    ),

    resolveAwakeable: restate.handler({}, (id: string) =>
      restate.resolveAwakeable(id, "ok")
    ),

    rejectAwakeable: restate.handler({}, (id: string) =>
      restate.rejectAwakeable(id, "error")
    ),

    incrementViaAwakeableDance: restate.handler(
      {},
      (input: {
        txPromiseId: string;
        interpreter: { layer: Layer; key: string };
      }) =>
        Effect.gen(function* () {
          const callback = yield* restate.awakeable<string>();
          yield* restate.resolveAwakeable(input.txPromiseId, callback.id);
          yield* callback.result;
          yield* restate.rpc.send<Program>({
            service: `ObjectInterpreterL${input.interpreter.layer}`,
            method: "interpret",
            key: input.interpreter.key,
            parameter: { commands: [{ kind: INCREMENT_STATE_COUNTER }] },
          });
        })
    ),
  },
});

/**
 * A command whose result is awaited later, by index.
 *
 * Held as a *running fiber*, not as an unstarted effect: the harness's programs
 * expect the operation to be in flight while later commands run, which is the
 * concurrency this SDK exists to make replay-safe.
 */
type Pending = {
  readonly expected: unknown;
  readonly fiber: Fiber.Fiber<unknown, restate.RestateFailure>;
};

type InterpreterRequirements =
  | restate.RestateContext
  | restate.ObjectKey
  | restate.StateRead
  | restate.StateWrite;

function makeInterpretHandler(layer: Layer) {
  return (program: Program) =>
    Effect.gen(function* () {
      const key = yield* restate.key;
      // Commands that produced something to await, by command index. A pending
      // command's *entry* is already created; only its result is outstanding.
      const pending = new Map<number, Pending>();

      const awaitPending = (
        index: number
      ): Effect.Effect<void, restate.RestateFailure, InterpreterRequirements> =>
        Effect.gen(function* () {
          const entry = pending.get(index);
          if (entry === undefined) return;
          pending.delete(index);
          const exit = yield* Effect.exit(Fiber.join(entry.fiber));
          const result: unknown = Exit.isSuccess(exit)
            ? deserializeIfNeeded(exit.value)
            : "rejected";
          if (JSON.stringify(result) !== JSON.stringify(entry.expected)) {
            return yield* restate.terminalError(
              `Expected ${JSON.stringify(entry.expected)} but got ${JSON.stringify(result)}`
            );
          }
        });

      const interpretOne = (
        cmd: Cmd,
        i: number
      ): Effect.Effect<
        void,
        restate.RestateFailure,
        InterpreterRequirements
      > => {
        switch (cmd.kind) {
          case SET_STATE:
            return restate.state.set(`key-${cmd.key}`, `value-${cmd.key}`);
          case GET_STATE:
            return Effect.asVoid(restate.state.get<string>(`key-${cmd.key}`));
          case CLEAR_STATE:
            return restate.state.clear(`key-${cmd.key}`);
          case INCREMENT_STATE_COUNTER:
            return Effect.gen(function* () {
              const counter =
                (yield* restate.state.get<number>("counter")) ?? 0;
              yield* restate.state.set("counter", counter + 1);
            });
          case SLEEP:
            return Effect.sleep(`${cmd.duration ?? 0} millis`);
          case CALL_SERVICE:
            return Effect.gen(function* () {
              const expected = `hello-${i}`;
              const fiber = yield* Effect.forkChild(
                restate.rpc.call<string, string>({
                  service: "ServiceInterpreterHelper",
                  method: "echo",
                  parameter: expected,
                })
              );
              pending.set(i, { expected, fiber });
            });
          case CALL_SLOW_SERVICE:
            return Effect.gen(function* () {
              const expected = `hello-${i}`;
              const fiber = yield* Effect.forkChild(
                restate.rpc.call<{ parameter: string; sleep: number }, string>({
                  service: "ServiceInterpreterHelper",
                  method: "echoLater",
                  parameter: { parameter: expected, sleep: cmd.sleep ?? 0 },
                })
              );
              pending.set(i, { expected, fiber });
            });
          case INCREMENT_VIA_DELAYED_CALL:
            return Effect.asVoid(
              restate.rpc.send<{ layer: Layer; key: string }>({
                service: "ServiceInterpreterHelper",
                method: "incrementIndirectly",
                parameter: { layer, key },
                delay: cmd.duration,
              })
            );
          case SIDE_EFFECT:
            return Effect.gen(function* () {
              const expected = `hello-${i}`;
              const result = yield* restate.run(
                "sideEffect",
                Effect.succeed(expected)
              );
              if (result !== expected) {
                return yield* restate.terminalError(
                  `Expected ${expected} but got ${result}`
                );
              }
            });
          case SLOW_SIDE_EFFECT:
            return Effect.void;
          case RECOVER_TERMINAL_CALL:
            return Effect.gen(function* () {
              const exit = yield* Effect.exit(
                restate.rpc.call<null, void>({
                  service: "ServiceInterpreterHelper",
                  method: "terminalFailure",
                  parameter: null,
                })
              );
              if (Exit.isSuccess(exit)) {
                return yield* restate.terminalError("Expected terminal error");
              }
            });
          case RECOVER_TERMINAL_MAYBE_UN_AWAITED:
            return Effect.void;
          case THROWING_SIDE_EFFECT:
            return Effect.asVoid(
              restate.run(
                "throwingSideEffect",
                Effect.suspend(() =>
                  Math.random() < 0.5
                    ? Effect.die(new Error("Random error"))
                    : Effect.void
                )
              )
            );
          case INCREMENT_STATE_COUNTER_INDIRECTLY:
            return Effect.asVoid(
              restate.rpc.send<{ layer: Layer; key: string }>({
                service: "ServiceInterpreterHelper",
                method: "incrementIndirectly",
                parameter: { layer, key },
              })
            );
          case RESOLVE_AWAKEABLE:
            return Effect.gen(function* () {
              const callback = yield* restate.awakeable<string>();
              const fiber = yield* Effect.forkChild(callback.result);
              pending.set(i, { expected: "ok", fiber });
              yield* restate.rpc.send<string>({
                service: "ServiceInterpreterHelper",
                method: "resolveAwakeable",
                parameter: callback.id,
              });
            });
          case REJECT_AWAKEABLE:
            return Effect.gen(function* () {
              const callback = yield* restate.awakeable<string>();
              const fiber = yield* Effect.forkChild(callback.result);
              pending.set(i, { expected: "rejected", fiber });
              yield* restate.rpc.send<string>({
                service: "ServiceInterpreterHelper",
                method: "rejectAwakeable",
                parameter: callback.id,
              });
            });
          case INCREMENT_STATE_COUNTER_VIA_AWAKEABLE:
            return Effect.gen(function* () {
              const exchange = yield* restate.awakeable<string>();
              yield* restate.rpc.send<{
                interpreter: { layer: Layer; key: string };
                txPromiseId: string;
              }>({
                service: "ServiceInterpreterHelper",
                method: "incrementViaAwakeableDance",
                parameter: {
                  interpreter: { layer, key },
                  txPromiseId: exchange.id,
                },
              });
              const theirId = yield* exchange.result;
              yield* restate.resolveAwakeable(theirId, "ok");
            });
          case CALL_NEXT_LAYER_OBJECT:
            return Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                restate.rpc.call<Program, void>({
                  service: `ObjectInterpreterL${layer + 1}`,
                  method: "interpret",
                  key: String(cmd.key ?? ""),
                  parameter: cmd.program ?? { commands: [] },
                })
              );
              // No expectation: the next layer's `interpret` returns nothing.
              pending.set(i, { expected: undefined, fiber });
            });
          default:
            return restate.terminalError(
              `Unknown command type: ${cmd.kind}`
            ) as Effect.Effect<void, restate.RestateFailure, never>;
        }
      };

      // Results are only checked where the program says so: a command that
      // registers something pending leaves it in flight until an explicit
      // AWAIT_PROMISE, which is what puts several durable operations in the
      // air at once.
      for (let i = 0; i < program.commands.length; i++) {
        const cmd = program.commands[i]!;
        if (cmd.kind === AWAIT_PROMISE && cmd.index !== undefined) {
          yield* awaitPending(cmd.index);
        } else {
          yield* interpretOne(cmd, i);
        }
      }
    });
}

/**
 * The harness's helpers return JSON-encoded payloads in some slots; mirror the
 * generator SDK's leniency so the comparison against `expected` matches.
 */
function deserializeIfNeeded(raw: unknown): unknown {
  if (raw instanceof Uint8Array && raw.length > 0) {
    return JSON.parse(new TextDecoder().decode(raw));
  }
  return raw;
}

const counterHandler = restate.sharedHandler({}, () =>
  Effect.map(restate.state.get<number>("counter"), (c) => c ?? 0)
);

export const objectInterpreterL0 = restate.object({
  name: "ObjectInterpreterL0",
  handlers: {
    interpret: restate.handler({}, makeInterpretHandler(0)),
    counter: counterHandler,
  },
});

export const objectInterpreterL1 = restate.object({
  name: "ObjectInterpreterL1",
  handlers: {
    interpret: restate.handler({}, makeInterpretHandler(1)),
    counter: counterHandler,
  },
});

export const objectInterpreterL2 = restate.object({
  name: "ObjectInterpreterL2",
  handlers: {
    interpret: restate.handler({}, makeInterpretHandler(2)),
    counter: counterHandler,
  },
});

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

// Drives the conformance service set (test-services/) through a real Restate
// container.
//
// The official harness (`restatedev/e2e`'s sdk-tests.jar, wired up in
// .github/workflows/integration-effect.yaml) is the authority; it needs Java, so
// this file covers the same services from vitest — in particular the two
// interpreters, which are where the combinator and journal-op coverage lives.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { connect, type Ingress } from "@restatedev/restate-sdk-clients";
import { awakeableHolder } from "../test-services/src/awakeable-holder.js";
import { blockAndWaitWorkflow } from "../test-services/src/block-and-wait-workflow.js";
import { counterObject } from "../test-services/src/counter.js";
import { failing } from "../test-services/src/failing.js";
import {
  objectInterpreterL0,
  objectInterpreterL1,
  objectInterpreterL2,
  serviceInterpreterHelper,
} from "../test-services/src/interpreter.js";
import { listObject } from "../test-services/src/list-object.js";
import { mapObject } from "../test-services/src/map-object.js";
import { proxy } from "../test-services/src/proxy.js";
import { testUtilsService } from "../test-services/src/test-utils.js";
import { virtualObjectCommandInterpreter } from "../test-services/src/vo-command-interpreter.js";

const SET_STATE = 1;
const GET_STATE = 2;
const INCREMENT_STATE_COUNTER = 4;
const SLEEP = 6;
const CALL_SERVICE = 7;
const CALL_SLOW_SERVICE = 8;
const SIDE_EFFECT = 10;
const RECOVER_TERMINAL_CALL = 13;
const AWAIT_PROMISE = 15;
const RESOLVE_AWAKEABLE = 16;
const REJECT_AWAKEABLE = 17;
const CALL_NEXT_LAYER_OBJECT = 19;

const modes = [
  { name: "default", alwaysReplay: false },
  { name: "alwaysReplay", alwaysReplay: true },
] as const;

describe.each(modes)(
  "conformance services — $name mode",
  ({ alwaysReplay }) => {
    let env: RestateTestEnvironment;
    let ingress: Ingress;
    const suffix = alwaysReplay ? "-replay" : "";

    beforeAll(async () => {
      env = await RestateTestEnvironment.start({
        services: [
          awakeableHolder,
          blockAndWaitWorkflow,
          counterObject,
          failing,
          listObject,
          mapObject,
          objectInterpreterL0,
          objectInterpreterL1,
          objectInterpreterL2,
          proxy,
          serviceInterpreterHelper,
          testUtilsService,
          virtualObjectCommandInterpreter,
        ],
        alwaysReplay,
      });
      ingress = connect({ url: env.baseUrl() });
    }, 180_000);

    afterAll(async () => {
      await env?.stop();
    });

    test("Counter", async () => {
      const key = `counter${suffix}`;
      const counter = ingress.client(counterObject, key);
      await expect(counter.add(1)).resolves.toEqual({
        oldValue: 0,
        newValue: 1,
      });
      await expect(counter.add(2)).resolves.toEqual({
        oldValue: 1,
        newValue: 3,
      });
      await expect(counter.get()).resolves.toBe(3);
      // A terminal failure still leaves the state it wrote before failing.
      await expect(counter.addThenFail(10)).rejects.toThrow(key);
      await expect(counter.get()).resolves.toBe(13);
      await counter.reset();
      await expect(counter.get()).resolves.toBe(0);
    });

    test("ListObject and MapObject", async () => {
      const list = ingress.client(listObject, `list${suffix}`);
      await list.append("a");
      await list.append("b");
      await expect(list.get()).resolves.toEqual(["a", "b"]);
      await expect(list.clear()).resolves.toEqual(["a", "b"]);
      await expect(list.get()).resolves.toEqual([]);

      const map = ingress.client(mapObject, `map${suffix}`);
      await map.set({ key: "k1", value: "v1" });
      await map.set({ key: "k2", value: "v2" });
      await expect(map.get("k1")).resolves.toBe("v1");
      await expect(map.clearAll()).resolves.toEqual([
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ]);
      await expect(map.get("k1")).resolves.toBe("");
    });

    test("Failing: terminal failures propagate, retries eventually succeed", async () => {
      const client = ingress.client(failing, `failing${suffix}`);
      await expect(
        client.terminallyFailingCall({ errorMessage: "bye" })
      ).rejects.toThrow("bye");
      await expect(
        client.callTerminallyFailingCall({ errorMessage: "propagated" })
      ).rejects.toThrow("propagated");
      await expect(client.failingCallWithEventualSuccess()).resolves.toBe(4);
      // The services count attempts in process-level state, and both modes share
      // this process, so the second run starts where the first left off. The
      // official harness gets a fresh container per suite; here, assert the
      // property (it eventually succeeded / it eventually gave up) rather than
      // the exact count.
      await expect(
        client.sideEffectSucceedsAfterGivenAttempts(3)
      ).resolves.toBeGreaterThanOrEqual(3);
      await expect(
        client.sideEffectFailsAfterGivenAttempts(2)
      ).resolves.toBeGreaterThanOrEqual(2);
    }, 60_000);

    test("TestUtilsService", async () => {
      const client = ingress.client(testUtilsService);
      await expect(client.echo("hi")).resolves.toBe("hi");
      await expect(client.uppercaseEcho("hi")).resolves.toBe("HI");
      // On a replay the recorded results are served, so the closures run once.
      await expect(
        client.countExecutedSideEffects(3)
      ).resolves.toBeLessThanOrEqual(3);
    });

    test("Proxy forwards calls and one-way calls", async () => {
      const key = `proxied${suffix}`;
      const client = ingress.client(proxy);
      const payload = Array.from(new TextEncoder().encode(JSON.stringify(5)));
      const result = await client.call({
        serviceName: "Counter",
        handlerName: "add",
        virtualObjectKey: key,
        message: payload,
      });
      expect(
        JSON.parse(new TextDecoder().decode(Uint8Array.from(result)))
      ).toEqual({
        oldValue: 0,
        newValue: 5,
      });

      const id = await client.oneWayCall({
        serviceName: "Counter",
        handlerName: "add",
        virtualObjectKey: key,
        message: payload,
      });
      expect(id).toMatch(/^inv_/);
      await expect(
        pollUntil(
          () => ingress.client(counterObject, key).get(),
          (v) => v === 10
        )
      ).resolves.toBe(10);
    }, 60_000);

    test("BlockAndWaitWorkflow blocks on a durable promise", async () => {
      const key = `wf${suffix}`;
      const workflow = ingress.client(blockAndWaitWorkflow, key);
      const running = workflow.run("payload");
      await expect(
        pollUntil(
          () => workflow.getState(),
          (v) => v === "payload"
        )
      ).resolves.toBe("payload");
      await workflow.unblock("unblocked");
      await expect(running).resolves.toBe("unblocked");
    }, 60_000);

    test("VirtualObjectCommandInterpreter: combinators over durable ops", async () => {
      const key = `cmd${suffix}`;
      const client = ingress.client(virtualObjectCommandInterpreter, key);

      // one sub-command
      await expect(
        client.interpretCommands({
          commands: [
            { type: "awaitOne", command: { type: "runReturns", value: "one" } },
          ],
        })
      ).resolves.toBe("one");

      // first to complete, out of a run and a long sleep
      await expect(
        client.interpretCommands({
          commands: [
            {
              type: "awaitFirstCompleted",
              commands: [
                { type: "runReturns", value: "fast" },
                { type: "sleep", timeoutMillis: 30_000 },
              ],
            },
          ],
        })
      ).resolves.toBe("fast");

      // all succeeded, in slot order
      await expect(
        client.interpretCommands({
          commands: [
            {
              type: "awaitAllSucceededOrFirstFailed",
              commands: [
                { type: "runReturns", value: "a" },
                { type: "runReturns", value: "b" },
              ],
            },
          ],
        })
      ).resolves.toBe("a|b");

      // all completed, including a failure
      await expect(
        client.interpretCommands({
          commands: [
            {
              type: "awaitAllCompleted",
              commands: [
                { type: "runReturns", value: "ok" },
                { type: "runThrowTerminalException", reason: "nope" },
              ],
            },
          ],
        })
      ).resolves.toBe("ok:ok|err:nope");

      // first success, skipping the failure
      await expect(
        client.interpretCommands({
          commands: [
            {
              type: "awaitAnySuccessful",
              commands: [
                { type: "runThrowTerminalException", reason: "nope" },
                { type: "runReturns", value: "survivor" },
              ],
            },
          ],
        })
      ).resolves.toBe("survivor");

      // an awakeable resolved from outside, racing a timeout
      const awaiting = client.interpretCommands({
        commands: [
          {
            type: "awaitAwakeableOrTimeout",
            awakeableKey: "k1",
            timeoutMillis: 60_000,
          },
        ],
      });
      await pollUntil(
        () => client.hasAwakeable("k1"),
        (has) => has === true
      );
      await client.resolveAwakeable({ awakeableKey: "k1", value: "released" });
      await expect(awaiting).resolves.toBe("released");

      // the timeout branch wins
      await expect(
        client.interpretCommands({
          commands: [
            {
              type: "awaitAwakeableOrTimeout",
              awakeableKey: "k2",
              timeoutMillis: 10,
            },
          ],
        })
      ).rejects.toThrow("await-timeout");

      const results = await client.getResults();
      expect(results.length).toBeGreaterThan(5);
    }, 120_000);

    test("ObjectInterpreter: a program of journal operations", async () => {
      const key = `interp${suffix}`;
      const l0 = ingress.client(objectInterpreterL0, key);

      await l0.interpret({
        commands: [
          { kind: SET_STATE, key: 1 },
          { kind: GET_STATE, key: 1 },
          { kind: INCREMENT_STATE_COUNTER },
          { kind: SLEEP, duration: 10 },
          { kind: SIDE_EFFECT },
          { kind: RECOVER_TERMINAL_CALL },
          { kind: CALL_SERVICE },
          { kind: CALL_SLOW_SERVICE, sleep: 30 },
          { kind: RESOLVE_AWAKEABLE },
          { kind: REJECT_AWAKEABLE },
          { kind: INCREMENT_STATE_COUNTER },
        ],
      });
      await expect(l0.counter()).resolves.toBe(2);

      // Concurrency across the whole program: several calls in flight, awaited
      // later by index, plus a nested call into the next layer.
      await l0.interpret({
        commands: [
          { kind: CALL_SLOW_SERVICE, sleep: 40 },
          { kind: CALL_SERVICE },
          {
            kind: CALL_NEXT_LAYER_OBJECT,
            key: 7,
            program: {
              commands: [
                { kind: INCREMENT_STATE_COUNTER },
                {
                  kind: CALL_NEXT_LAYER_OBJECT,
                  key: 9,
                  program: { commands: [] },
                },
                { kind: AWAIT_PROMISE, index: 1 },
              ],
            },
          },
          { kind: AWAIT_PROMISE, index: 0 },
          { kind: AWAIT_PROMISE, index: 1 },
          { kind: AWAIT_PROMISE, index: 2 },
        ],
      });
      await expect(
        ingress.client(objectInterpreterL1, "7").counter()
      ).resolves.toBe(1);
      await expect(
        ingress.client(objectInterpreterL2, "9").counter()
      ).resolves.toBe(0);
    }, 120_000);
  }
);

/** Poll `read` until `done` accepts its value, or time out. */
async function pollUntil<A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  attempts = 60,
  intervalMillis = 250
): Promise<A> {
  let last: A = await read();
  for (let i = 0; i < attempts; i++) {
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMillis));
    last = await read();
  }
  return last;
}

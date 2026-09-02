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

// Cancellation, end to end (DESIGN §3.4, TODO S4-4).
//
// Restate cancellation is mapped to interrupting the handler's root fiber. What
// that has to buy us, and what these tests check:
//
//   - finalizers run, in order, and may perform journal operations of their own;
//   - the main line does not continue past the interrupt;
//   - a `run` closure's AbortSignal fires, so in-flight I/O stops;
//   - a race loser's finalizer runs when the race is decided (no cancellation
//     involved — the ordinary structured-concurrency path).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { connect, type Ingress } from "@restatedev/restate-sdk-clients";
import { Effect } from "effect";
import * as restate from "../src/index.js";

const blocker = restate.object({
  name: "cancel-blocker",
  handlers: {
    // Blocks on a durable timer. On interrupt the finalizer writes state — a
    // journal operation performed *during* teardown.
    block: restate.handler({}, () =>
      Effect.gen(function* () {
        yield* restate.state.set("phase", "started");
        yield* Effect.sleep("1 hour");
        yield* restate.state.set("phase", "finished");
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* restate.run("cleanup", Effect.succeed("done"));
            yield* restate.state.set("phase", "cleaned-up");
          })
        )
      )
    ),

    // Blocks inside a `run` closure that honours its AbortSignal.
    blockInRun: restate.handler({}, () =>
      Effect.gen(function* () {
        yield* restate.state.set("phase", "started");
        yield* restate.run(
          "await-signal",
          Effect.gen(function* () {
            const { signal } = yield* restate.RunSignal;
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  if (signal.aborted) return resolve();
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                })
            );
          })
        );
        yield* restate.state.set("phase", "finished");
      }).pipe(
        Effect.onInterrupt(() => restate.state.set("phase", "cleaned-up"))
      )
    ),

    phase: restate.sharedHandler({}, () => restate.state.get<string>("phase")),

    reset: restate.handler({}, () => restate.state.clear("phase")),
  },
});

const raceLoser = restate.object({
  name: "cancel-race",
  handlers: {
    run: restate.handler({}, () =>
      Effect.gen(function* () {
        const winner = yield* Effect.race(
          restate.run("fast", Effect.succeed("fast")),
          Effect.as(Effect.sleep("1 hour"), "slow").pipe(
            Effect.onInterrupt(() => restate.state.set("loser", "torn-down"))
          )
        );
        return `${winner}/${(yield* restate.state.get<string>("loser")) ?? "?"}`;
      })
    ),
  },
});

const canceller = restate.service({
  name: "canceller",
  handlers: {
    cancel: restate.handler({}, (invocationId: string) =>
      restate.cancel(invocationId as never)
    ),
  },
});

describe("cancellation", () => {
  let env: RestateTestEnvironment;
  let ingress: Ingress;

  beforeAll(async () => {
    env = await RestateTestEnvironment.start({
      services: [blocker, raceLoser, canceller],
    });
    ingress = connect({ url: env.baseUrl() });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  });

  test("interrupts the handler and runs its finalizer, which may journal", async () => {
    const key = "sleep";
    const handle = await ingress.sendClient(blocker, key).block();
    await waitForPhase(ingress, key, "started");

    await ingress.client(canceller).cancel(handle.invocationId);

    // "cleaned-up", not "finished": the main line stopped at the interrupt and
    // the finalizer's own journal operations still landed.
    await expect(waitForPhase(ingress, key, "cleaned-up")).resolves.toBe(
      "cleaned-up"
    );
  }, 90_000);

  test("aborts the AbortSignal of an in-flight run closure", async () => {
    const key = "in-run";
    const handle = await ingress.sendClient(blocker, key).blockInRun();
    await waitForPhase(ingress, key, "started");

    await ingress.client(canceller).cancel(handle.invocationId);

    await expect(waitForPhase(ingress, key, "cleaned-up")).resolves.toBe(
      "cleaned-up"
    );
  }, 90_000);

  test("a race loser is torn down when the race is decided", async () => {
    await expect(ingress.client(raceLoser, "r1").run()).resolves.toBe(
      "fast/torn-down"
    );
  }, 90_000);
});

async function waitForPhase(
  ingress: Ingress,
  key: string,
  expected: string,
  attempts = 120,
  intervalMillis = 250
): Promise<string | null> {
  let phase = await ingress.client(blocker, key).phase();
  for (let i = 0; i < attempts && phase !== expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMillis));
    phase = await ingress.client(blocker, key).phase();
  }
  return phase;
}

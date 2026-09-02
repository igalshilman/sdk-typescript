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

// End-to-end against a real Restate runtime (TODO S4-7).
//
// Both runtime modes run every test. `alwaysReplay` is the important one: the
// invoker's inactivity timeout is zero, so the invocation suspends between steps
// and the handler is replayed from the journal at every step. Any drift in the
// deterministic runtime shows up here as a journal mismatch.
//
// Local runs need Docker.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { connect, Opts, type Ingress } from "@restatedev/restate-sdk-clients";
import { Clock, Duration, Effect, Exit, Queue, Schedule, Schema } from "effect";
import * as restate from "../src/index.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Set from inside a losing `run` closure; see `raced3`. */
let raceAbortObserved = false;
/** Executions of `countPings`, for the idempotency-key assertion. */
let pingCount = 0;

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  item: Schema.String,
}) {}

class TooEarly extends Schema.TaggedError<TooEarly>()("TooEarly", {
  attempts: Schema.Number,
}) {}

const basics = restate.service({
  name: "effect-basics",
  handlers: {
    // One durable step, plus a durable timer through plain Effect.sleep.
    greet: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) =>
        Effect.gen(function* () {
          const stamp = yield* restate.run(
            "stamp",
            Effect.promise(async () => {
              await wait(5);
              return "stamped";
            })
          );
          yield* Effect.sleep("10 millis");
          return `hello ${name} (${stamp})`;
        })
    ),

    // Two durable steps in parallel: plain Effect.all, journaled interleaving.
    concurrent: restate.handler(
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.gen(function* () {
          const [a, b] = yield* Effect.all(
            [
              restate.run(
                "slow",
                Effect.promise(async () => {
                  await wait(60);
                  return "alpha";
                })
              ),
              restate.run(
                "fast",
                Effect.promise(async () => {
                  await wait(5);
                  return "bravo";
                })
              ),
            ],
            { concurrency: "unbounded" }
          );
          return `${a}+${b}`;
        })
    ),

    // A race between a durable step and a durable timer: the loser is torn down.
    raced: restate.handler({ input: Schema.Void, output: Schema.String }, () =>
      Effect.race(
        restate.run(
          "quick",
          Effect.promise(async () => {
            await wait(5);
            return "quick";
          })
        ),
        Effect.as(Effect.sleep("30 seconds"), "timer")
      )
    ),

    // Effect.timeout over a durable step — a durable timeout, for free.
    timedOut: restate.handler(
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.sleep("30 seconds").pipe(
          Effect.timeout("50 millis"),
          Effect.match({
            onFailure: () => "timed out",
            onSuccess: () => "slept",
          })
        )
    ),

    // Background fiber coordinating with the main line over an in-memory queue.
    forked: restate.handler({ input: Schema.Void, output: Schema.String }, () =>
      Effect.gen(function* () {
        const events = yield* Queue.make<string>();
        yield* Effect.forkChild(
          Effect.gen(function* () {
            const value = yield* restate.run(
              "background",
              Effect.succeed("from-fork")
            );
            yield* Queue.offer(events, value);
          })
        );
        return yield* Queue.take(events);
      })
    ),

    // A declared domain error: encoded into the terminal error body.
    order: restate.handler(
      {
        input: Schema.String,
        output: Schema.String,
        error: OutOfStock,
        errorCode: 409,
      },
      (item) =>
        Effect.gen(function* () {
          if (item === "unicorn") return yield* new OutOfStock({ item });
          return `ordered ${item}`;
        })
    ),

    // Regression: a plain service context has no key, and reading its `key`
    // getter *throws* — so `handlerRequest` must decide from the handler kind
    // rather than probe it. (Caught by sdk-test-suite's
    // `Ingress.headersPassThrough`.)
    describeRequest: restate.handler(
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.map(
          restate.handlerRequest,
          (request) =>
            `${request.key ?? "-"}:${request.id.length > 0 ? "id" : "no-id"}`
        )
    ),

    // codex@effect-restate-review's regression for the race-loser abort.
    //
    // A slow `run` observing its RunSignal races a fast durable winner, and a
    // durable op follows the race. Three things have to hold: the loser's
    // signal aborts, the race resolves to the fast winner, and the trailing op
    // still lands in the same journal position on replay — the last is why the
    // trailing op is here at all.
    raced3: restate.handler({ input: Schema.Void, output: Schema.String }, () =>
      Effect.gen(function* () {
        const winner = yield* Effect.race(
          restate.run(
            "slow",
            Effect.gen(function* () {
              const { signal } = yield* restate.RunSignal;
              signal.addEventListener("abort", () => {
                raceAbortObserved = true;
              });
              yield* Effect.promise(() => wait(3_000));
              return "slow";
            })
          ),
          restate.run("fast", Effect.succeed("fast"))
        );
        const after = yield* restate.run("after", Effect.succeed("after"));
        return `${winner}+${after}`;
      })
    ),

    // A documented limitation, pinned so a fix upstream is noticed: Effect's
    // `timed` reads the clock *unsafely*, and unsafe reads are frozen at
    // attempt entry, so the measured duration is zero however long the durable
    // sleep took. If this ever returns non-zero, SHARP-EDGES.md is out of date.
    timedSleep: restate.handler(
      { input: Schema.Void, output: Schema.Number },
      () =>
        Effect.map(Effect.timed(Effect.sleep("1 second")), ([duration]) =>
          Duration.toMillis(duration)
        )
    ),

    // Elapsed time measured the supported way: journaled clock reads.
    measuredSleep: restate.handler(
      { input: Schema.Void, output: Schema.Boolean },
      () =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          yield* Effect.sleep("1 second");
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          return elapsed >= 900;
        })
    ),

    // Whether the losing closure's signal ever aborted. Process-level, because
    // an aborted step cannot report anything through the journal.
    raceAbortSeen: restate.handler(
      { input: Schema.Void, output: Schema.Boolean },
      () => Effect.sync(() => raceAbortObserved)
    ),

    // A void-input handler that counts executions, to prove an idempotency key
    // reaches Restate rather than being serialized as the request body.
    countPings: restate.handler(
      { input: Schema.Void, output: Schema.Number },
      () => Effect.sync(() => ++pingCount)
    ),

    // A non-void handler whose input is shaped exactly like CallOptions: it
    // must arrive as the body, untouched.
    echoOptionsShaped: restate.handler(
      {
        input: Schema.Struct({ idempotencyKey: Schema.String }),
        output: Schema.String,
      },
      (input) => Effect.succeed(input.idempotencyKey)
    ),

    // Saga: observe a failing step as an Exit and compensate.
    saga: restate.handler({ input: Schema.Void, output: Schema.String }, () =>
      Effect.gen(function* () {
        const charged = yield* restate.runExit(
          "charge",
          Effect.die(new Error("card declined")),
          { retry: { maxAttempts: 1 } }
        );
        if (Exit.isSuccess(charged)) return "charged";
        const refund = yield* restate.run("refund", Effect.succeed("refunded"));
        return `compensated:${refund}`;
      })
    ),
  },
});

/** The same service as an imported contract, to exercise the `iface` path. */
const basicsContract = restate.iface.service("effect-basics", {
  countPings: restate.iface.json<void, number>(),
});

const counter = restate.object({
  name: "effect-counter",
  handlers: {
    add: restate.handler(
      { input: Schema.Number, output: Schema.Number },
      (delta) =>
        Effect.gen(function* () {
          const current = yield* restate.state.get("count", Schema.Number);
          const next = (current ?? 0) + delta;
          yield* restate.state.set("count", Schema.Number, next);
          return next;
        })
    ),
    get: restate.sharedHandler(
      { input: Schema.Void, output: Schema.Number },
      () =>
        Effect.map(
          restate.state.get("count", Schema.Number),
          (count) => count ?? 0
        )
    ),
    // The keyed counterpart of `basics.describeRequest`: here the key is real.
    describeRequest: restate.sharedHandler(
      { input: Schema.Void, output: Schema.String },
      () =>
        Effect.map(
          restate.handlerRequest,
          (request) =>
            `${request.key ?? "-"}:${request.id.length > 0 ? "id" : "no-id"}`
        )
    ),

    // The in-handler client's positional rule, at runtime.
    //
    // Options live in second position, so the idempotency key must reach
    // Restate as a header (the two calls dedupe to one execution) and an
    // options-shaped body must survive as the body. Checked through both a
    // definition and an imported `iface` contract, since a contract carries its
    // own descriptors.
    clientRules: restate.handler(
      { input: Schema.String, output: Schema.String },
      (key) =>
        Effect.gen(function* () {
          const viaDefinition = restate.client(basics);
          const first = yield* viaDefinition.countPings(undefined, {
            idempotencyKey: key,
          });
          const second = yield* viaDefinition.countPings(undefined, {
            idempotencyKey: key,
          });
          const echoed = yield* viaDefinition.echoOptionsShaped({
            idempotencyKey: "body",
          });
          const viaContract = restate.client(basicsContract);
          const third = yield* viaContract.countPings(undefined, {
            idempotencyKey: key,
          });
          return `${first === second}:${first === third}:${echoed}`;
        })
    ),

    // Calls another service: an ordinary journal source.
    greetVia: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) => restate.client(basics).greet(name)
    ),

    // Domain-level retry with durable backoff: the failure is a plain typed
    // failure, `Effect.retry`'s delays are durable timers, and the attempt
    // counter lives in object state so the outcome is deterministic per key.
    flaky: restate.handler({ input: Schema.Void, output: Schema.Number }, () =>
      Effect.gen(function* () {
        const attempts =
          (yield* restate.state.get("attempts", Schema.Number)) ?? 0;
        yield* restate.state.set("attempts", Schema.Number, attempts + 1);
        if (attempts < 2) return yield* new TooEarly({ attempts });
        return attempts;
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("10 millis"),
          times: 5,
        }),
        Effect.orDie
      )
    ),
  },
});

const modes = [
  { name: "default", alwaysReplay: false },
  { name: "alwaysReplay", alwaysReplay: true },
] as const;

describe.each(modes)("effect handlers — $name mode", ({ alwaysReplay }) => {
  let env: RestateTestEnvironment;
  let ingress: Ingress;

  beforeAll(async () => {
    env = await RestateTestEnvironment.start({
      services: [basics, counter],
      alwaysReplay,
    });
    ingress = connect({ url: env.baseUrl() });
  }, 180_000);

  afterAll(async () => {
    await env?.stop();
  });

  test("a durable step and a durable sleep", async () => {
    const client = ingress.client(basics);
    await expect(client.greet("world")).resolves.toBe("hello world (stamped)");
  });

  test("handlerRequest works in a service handler, and has no key", async () => {
    const client = ingress.client(basics);
    await expect(client.describeRequest()).resolves.toBe("-:id");
  });

  test("handlerRequest carries the key in an object handler", async () => {
    const client = ingress.client(counter, `req-${alwaysReplay}`);
    await expect(client.describeRequest()).resolves.toBe(
      `req-${alwaysReplay}:id`
    );
  });

  test("a race loser's run closure is aborted, and replay is unchanged", async () => {
    raceAbortObserved = false;
    const client = ingress.client(basics);
    // The fast branch wins; the trailing durable op keeps its journal position.
    await expect(client.raced3()).resolves.toBe("fast+after");
    // The losing closure observed its own signal aborting.
    await expect(client.raceAbortSeen()).resolves.toBe(true);
  });

  test("Effect.timed measures zero (documented limitation)", async () => {
    const client = ingress.client(basics);
    // Unsafe clock reads are frozen per attempt. Pinned so an upstream fix is
    // caught by CI rather than by a user.
    await expect(client.timedSleep()).resolves.toBe(0);
  });

  test("journaled clock reads do measure elapsed time", async () => {
    const client = ingress.client(basics);
    await expect(client.measuredSleep()).resolves.toBe(true);
  });

  test("an idempotency key on a void handler is an option, not the body", async () => {
    const before = await ingress.client(basics).countPings();
    const client = ingress.client(basics);
    const key = `idem-${alwaysReplay}-${before}`;
    // The ingress client takes options as a branded `Opts`, which sidesteps the
    // ambiguity by construction; the in-handler client's positional rule is
    // asserted at the type level in test/contracts.test.ts.
    const first = await client.countPings(Opts.from({ idempotencyKey: key }));
    const second = await client.countPings(Opts.from({ idempotencyKey: key }));
    // Restate served the second call from the first invocation's result, which
    // it can only do if the key reached it as a header.
    expect(second).toBe(first);
  });

  test("the in-handler client puts options in second position", async () => {
    const client = ingress.client(counter, `rules-${alwaysReplay}`);
    // dedupe-by-key : same via contract : options-shaped body preserved
    await expect(client.clientRules(`k-${alwaysReplay}`)).resolves.toBe(
      "true:true:body"
    );
  });

  test("a body shaped like CallOptions is still the body", async () => {
    const client = ingress.client(basics);
    await expect(
      client.echoOptionsShaped({ idempotencyKey: "not-an-option" })
    ).resolves.toBe("not-an-option");
  });

  test("concurrent durable steps resolve in slot order", async () => {
    const client = ingress.client(basics);
    await expect(client.concurrent()).resolves.toBe("alpha+bravo");
  });

  test("race resolves to the winner", async () => {
    const client = ingress.client(basics);
    await expect(client.raced()).resolves.toBe("quick");
  });

  test("Effect.timeout over a durable sleep is a durable timeout", async () => {
    const client = ingress.client(basics);
    await expect(client.timedOut()).resolves.toBe("timed out");
  });

  test("a forked fiber hands its result back over a queue", async () => {
    const client = ingress.client(basics);
    await expect(client.forked()).resolves.toBe("from-fork");
  });

  test("declared domain errors surface as terminal failures", async () => {
    const client = ingress.client(basics);
    await expect(client.order("book")).resolves.toBe("ordered book");
    await expect(client.order("unicorn")).rejects.toThrow(/OutOfStock/);
  });

  test("a saga compensates a failed step", async () => {
    const client = ingress.client(basics);
    await expect(client.saga()).resolves.toBe("compensated:refunded");
  });

  test("virtual-object state survives replay", async () => {
    const client = ingress.client(counter, `k-${alwaysReplay}`);
    await expect(client.add(2)).resolves.toBe(2);
    await expect(client.add(3)).resolves.toBe(5);
    await expect(client.get()).resolves.toBe(5);
  });

  test("calling another service", async () => {
    const client = ingress.client(counter, `via-${alwaysReplay}`);
    await expect(client.greetVia("callee")).resolves.toBe(
      "hello callee (stamped)"
    );
  });

  test("Effect.retry backs off durably and eventually succeeds", async () => {
    const client = ingress.client(counter, `flaky-${alwaysReplay}`);
    await expect(client.flaky()).resolves.toBe(2);
  });
});

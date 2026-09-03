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

import { Context, Effect, Exit, Ref, Schema } from "effect";
import * as sdk from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";
import * as restate from "../src/index.js";
import { Driver } from "../src/internal.js";
import { FakeJournal } from "./harness.js";

/** Exact type equality, including union order-insensitivity. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertType = <T extends true>(): void => {
  void 0 as unknown as T;
};

class ActivityError extends Schema.TaggedError<ActivityError>()(
  "ActivityError",
  { attempt: Schema.Number }
) {}

type RecordEntry = {
  readonly bytes: Uint8Array;
};

/**
 * A minimal `ctx.run` harness. Record mode executes actions and stores their
 * serialized outcomes; replay mode serves those bytes without executing them.
 */
class ActivityHarness {
  readonly records: RecordEntry[] = [];
  readonly defects: unknown[] = [];
  readonly runOptions: sdk.RunOptions<unknown>[] = [];
  raceWinners: string[] = [];
  actionExecutions = 0;

  async execute<A, E>(
    effect: Effect.Effect<A, E, restate.RestateContext>,
    replay = false
  ): Promise<Exit.Exit<A, E>> {
    const journal = new FakeJournal(
      replay ? "replay" : "record",
      replay ? this.raceWinners : []
    );
    const driver = new Driver(journal);
    let commandIndex = 0;
    const harness = this;

    const ctx = {
      run<T>(
        _name: string,
        action: sdk.RunAction<T>,
        options: sdk.RunOptions<T>
      ): sdk.RestatePromise<T> {
        const index = commandIndex++;
        const entryName = `activity.${index}`;
        const entry = journal.entry<T>(entryName);
        const serde = (options.serde ?? sdk.serde.json) as sdk.Serde<T>;
        harness.runOptions.push(options as sdk.RunOptions<unknown>);

        if (replay) {
          const recorded = harness.records[index];
          if (recorded === undefined) {
            throw new Error(`No recorded activity outcome at index ${index}`);
          }
          journal.complete(entryName, serde.deserialize(recorded.bytes));
          return entry as unknown as sdk.RestatePromise<T>;
        }

        harness.actionExecutions += 1;
        void Promise.resolve()
          .then(action)
          .then(
            (value) => {
              const bytes = serde.serialize(value);
              harness.records[index] = { bytes: bytes.slice() };
              journal.complete(entryName, serde.deserialize(bytes));
            },
            (defect: unknown) => {
              harness.defects.push(defect);
              const message =
                defect instanceof Error ? defect.message : String(defect);
              journal.fail(entryName, new sdk.TerminalError(message));
            }
          );
        return entry as unknown as sdk.RestatePromise<T>;
      },
    };

    const invocation: restate.RestateInvocation = {
      ctx: ctx as unknown as sdk.internal.ContextInternal,
      kind: "service",
      driver,
      appContext: Context.empty(),
      attemptStartMillis: 0,
    };
    const context = Context.add(
      Context.empty(),
      restate.RestateContext,
      invocation
    );
    const exit = await driver.run(
      effect as Effect.Effect<A, E, never>,
      context as Context.Context<never>
    );
    if (!replay) this.raceWinners = [...journal.raceWinners];
    return exit;
  }
}

describe("activity", () => {
  it("is a pipeable, lazy success boundary", async () => {
    const harness = new ActivityHarness();
    let executions = 0;
    const effect = Effect.sync(() => {
      executions += 1;
      return { value: 42 };
    }).pipe(
      restate.activity("answer", {
        result: Schema.Struct({ value: Schema.Number }),
      })
    );

    expect(executions).toBe(0);
    const exit = await harness.execute(effect);
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ value: 42 });
    expect(executions).toBe(1);
    expect(harness.records).toHaveLength(1);
  });

  it("journals typed failures and restores the typed error channel", async () => {
    const harness = new ActivityHarness();
    const effect = Effect.fail(new ActivityError({ attempt: 1 })).pipe(
      restate.activity("typed-failure", {
        result: Schema.String,
        error: ActivityError,
      })
    );
    assertType<
      Equals<
        Effect.Error<typeof effect>,
        ActivityError | restate.RestateFailure
      >
    >();

    const observed = effect.pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: (value) => value,
      })
    );
    const exit = await harness.execute(observed);
    expect(Exit.isSuccess(exit) && exit.value).toBeInstanceOf(ActivityError);
    expect(harness.defects).toEqual([]);
    expect(harness.records).toHaveLength(1);
  });

  it("lets Effect own typed retries and replays every attempt", async () => {
    const harness = new ActivityHarness();
    let executions = 0;
    const program = () =>
      Effect.suspend(() => {
        executions += 1;
        return executions < 3
          ? Effect.fail(new ActivityError({ attempt: executions }))
          : Effect.succeed(executions);
      }).pipe(
        restate.activity("retryable-domain-operation", {
          result: Schema.Number,
          error: ActivityError,
        }),
        Effect.retry({
          times: 2,
          while: (error) => error instanceof ActivityError,
        })
      );

    const recorded = await harness.execute(program());
    expect(Exit.isSuccess(recorded) && recorded.value).toBe(3);
    expect(executions).toBe(3);
    expect(harness.actionExecutions).toBe(3);
    expect(harness.records).toHaveLength(3);

    executions = 0;
    const replayed = await harness.execute(program(), true);
    expect(Exit.isSuccess(replayed) && replayed.value).toBe(3);
    expect(executions).toBe(0);
    expect(harness.actionExecutions).toBe(3);
  });

  it("replays concurrent activity completion order across fibers", async () => {
    const harness = new ActivityHarness();
    const program = Effect.gen(function* () {
      const completions = yield* Ref.make<ReadonlyArray<string>>([]);
      const invoke = (label: string, delay: number) =>
        Effect.promise(async () => {
          if (delay > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
          }
          return label;
        }).pipe(
          restate.activity(label, { result: Schema.String }),
          Effect.tap(() =>
            Ref.update(completions, (labels) => [...labels, label])
          )
        );

      yield* Effect.all([invoke("slow", 20), invoke("fast", 0)], {
        concurrency: "unbounded",
      });
      return yield* Ref.get(completions);
    });

    const recorded = await harness.execute(program);
    expect(Exit.isSuccess(recorded) && recorded.value).toEqual([
      "fast",
      "slow",
    ]);
    expect(harness.raceWinners).toEqual(["activity.1"]);

    const replayed = await harness.execute(program, true);
    expect(Exit.isSuccess(replayed) && replayed.value).toEqual([
      "fast",
      "slow",
    ]);
    expect(harness.actionExecutions).toBe(2);
  });

  it("does not capture defects in the typed outcome", async () => {
    const harness = new ActivityHarness();
    const effect = Effect.die(new Error("gateway unavailable")).pipe(
      restate.activity("defect", { result: Schema.String }),
      Effect.match({
        onFailure: (failure) => failure,
        onSuccess: (value) => value,
      })
    );

    const exit = await harness.execute(effect);
    expect(harness.defects).toHaveLength(1);
    expect(harness.defects[0]).toEqual(new Error("gateway unavailable"));
    expect(Exit.isSuccess(exit) && exit.value).toBeInstanceOf(
      restate.RestateFailure
    );
  });

  it("forwards Restate-owned defect retry options", async () => {
    const harness = new ActivityHarness();
    const effect = Effect.succeed("ok").pipe(
      restate.activity("configured", {
        result: Schema.String,
        retry: { maxAttempts: 4, initialInterval: 25 },
      })
    );
    await harness.execute(effect);
    expect(harness.runOptions[0]?.maxRetryAttempts).toBe(4);
    expect(harness.runOptions[0]?.initialRetryInterval).toBe(25);
  });

  it("requires an error codec for a typed failure", () => {
    const infallibleOnly = restate.activity("missing-error-codec", {
      result: Schema.String,
    });
    const bad = () =>
      // @ts-expect-error — typed activity failures cross the journal.
      infallibleOnly(Effect.fail(new ActivityError({ attempt: 1 })));
    void bad;
  });
});

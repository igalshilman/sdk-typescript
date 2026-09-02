# @restatedev/restate-sdk-effect

Run [Effect](https://effect.website) programs durably on
[Restate](https://restate.dev) — including `Effect.forkChild`, `Effect.race`,
concurrent `Effect.all`, `Queue`, `Semaphore`, `Schedule`, `Effect.timeout` and
`Effect.retry`.

> **Status: pre-release.** Targets Effect 4, which is itself at RC. The first
> non-pre-release publish waits for `effect@4.0.0` final — see
> [DESIGN.md](./DESIGN.md) §9.

## Installation

```bash
npm install @restatedev/restate-sdk-effect @restatedev/restate-sdk effect
```

`effect` and `@restatedev/restate-sdk` are peer dependencies.

## Quickstart

```ts
import { Effect, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

const greeter = restate.service({
  name: "greeter",
  handlers: {
    greet: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) =>
        Effect.gen(function* () {
          // A journaled step: executed once, replayed from the journal after.
          const id = yield* restate.run(
            "gen-id",
            Effect.sync(() => crypto.randomUUID())
          );

          // A durable timer: the invocation suspends and resumes an hour later,
          // surviving process restarts.
          yield* Effect.sleep("1 hour");

          return `Hello ${name} (${id})`;
        })
    ),
  },
});

restate.serve({ services: [greeter], port: 9080 });
```

## What is durable

Because this SDK owns Effect's scheduler and replays fiber wake-ups from the
journal, ordinary Effect combinators are the durable ones:

| You write | What happens |
|---|---|
| `Effect.sleep("30 minutes")` | a durable timer; the invocation suspends |
| `Effect.timeout("30 seconds")` | a durable timeout |
| `Effect.retry({ schedule: Schedule.exponential("1 second") })` | domain-level retry with durable backoff, resumable mid-backoff |
| `Effect.all([...], { concurrency: "unbounded" })` | parallel durable steps; the interleaving is journaled |
| `Effect.race(a, b)` | the winner is journaled; the loser is interrupted and its finalizers run |
| `Effect.forkChild(...)` | a background fiber, interrupted and finalized before the invocation ends |
| `Clock.currentTimeMillis`, `Random` | journaled reads |
| `Effect.log*`, `Console.*` | routed through Restate's replay-aware console |
| `Queue`, `Deferred`, `Semaphore`, `PubSub`, `FiberRef` | in-memory, deterministic |

There is deliberately **no** `Restate.sleep`, `Restate.timeout`,
`Restate.race` or `Restate.all`. The Effect combinators are those things.

## The three rules

1. **All real-world async goes through `restate.run`.** A raw
   `Effect.promise` / `Effect.tryPromise` / `Effect.callback` in handler code
   wakes a fiber from outside the journal, which would diverge on replay. The
   common shapes are caught at runtime — the invocation fails with `unjournaled
   async detected` instead of corrupting its journal — but the check is
   best-effort, not a guarantee ([SHARP-EDGES.md](./SHARP-EDGES.md) lists what
   slips past), so this is a rule you follow, not one you lean on. Inside a
   `run` closure anything
   goes — it executes on your application runtime, with the real clock and the
   real scheduler, and only its journaled result re-enters the deterministic
   world.
2. **No unsafe sync nondeterminism in handler code** — no `Date.now()`,
   `Math.random()`, `crypto.randomUUID()`. Use `Clock`, `Random`,
   `restate.uuid`, or wrap it in `restate.run`.
3. **Values that cross the journal are Schema-governed** — handler input and
   output, state, `run` results, awakeable payloads.

## Operations that need an explicit call

```ts
restate.run(name, effect, opts?)      // a journaled step
restate.runExit(name, effect, opts?)  // ...observed as an Exit, for sagas
restate.state.get / set / clear / clearAll / keys
restate.key                           // the object / workflow key
restate.awakeable(schema)             // { id, result }
restate.resolveAwakeable / rejectAwakeable
restate.client(Contract, key?)        // typed request-response RPC
restate.sendClient(Contract, key?)    // typed one-way RPC
restate.workflowPromise(name, schema)
restate.signal / attach / cancel
restate.handlerRequest / uuid / isProcessing / invocationSignal
restate.rawContext / restate.durable(name, ctx => RestatePromise)  // escape hatch
```

## Virtual objects and workflows

```ts
const counter = restate.object({
  name: "counter",
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
    // Shared handlers run concurrently with the exclusive ones, so they may
    // read state but not write it — writing from here is a *compile* error.
    get: restate.sharedHandler({ input: Schema.Void, output: Schema.Number }, () =>
      Effect.map(restate.state.get("count", Schema.Number), (c) => c ?? 0)
    ),
  },
});
```

`restate.workflow({ name, handlers })` works the same way; the handler named
`run` is the workflow handler, the others are shared, and
`restate.workflowPromise` is available in both.

## Application services

Application dependencies come from one `Layer`, built once per process:

```ts
class Db extends Effect.Service<Db>()("Db", { effect: makeDb }) {}

const orders = restate.service({
  name: "orders",
  handlers: {
    place: restate.handler({ input: Order, output: Schema.String }, (order) =>
      Effect.gen(function* () {
        const db = yield* Db;
        return yield* restate.run("insert", db.insert(order));
      })
    ),
  },
});

restate.serve({ services: [orders], layer: Db.Default });
```

`serve` typechecks the layer against what the handlers need. If an unexpected
capability (`StateWrite`, `DurablePromise`, …) turns up as unsatisfiable there,
a handler is using an operation its kind does not allow.

## Errors

A handler declares its domain errors, which are encoded into the terminal
error's body and decoded back on the calling side:

```ts
class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  item: Schema.String,
}) {}

order: restate.handler(
  { input: Schema.String, output: Schema.String, error: OutOfStock, errorCode: 409 },
  (item) => (item === "unicorn" ? new OutOfStock({ item }) : Effect.succeed(`ok`))
)

// caller
const result = yield* restate.client(Shop).order("unicorn").pipe(
  restate.decodeFailure(OutOfStock),
  Effect.catchTag("OutOfStock", () => Effect.succeed("suggest something else"))
);
```

Undeclared failures and defects are *not* terminal: Restate retries the
attempt. Interruption reports the invocation as cancelled.

## Documentation

- [guide.md](./guide.md) — the full authoring guide
- [SHARP-EDGES.md](./SHARP-EDGES.md) — what to watch out for
- [COMPARISON.md](./COMPARISON.md) — versus the promise SDK, `restate-sdk-gen`,
  and a thin Effect binding
- [DESIGN.md](./DESIGN.md) — how the deterministic runtime works, and why it is
  correct

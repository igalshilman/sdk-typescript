# Which Restate SDK for TypeScript?

Four ways to write a Restate handler in TypeScript. They interoperate — a
service written with any of them can call and be called by the others, because
they share `@restatedev/restate-sdk-core`'s contracts.

| | promise SDK | `restate-sdk-gen` | thin Effect binding | **this package** |
|---|---|---|---|---|
| Handler shape | `async (ctx, input)` | `function* (input)` | `(input) => Effect` | `(input) => Effect` |
| External activity | `ctx.run(...)` | `yield* run(...)` | `Restate.run(...)` | `effect.pipe(restate.activity(...))` |
| Concurrency over durable ops | `RestatePromise.all/race/any` | `all` / `race` / `any` / `select` / `spawn` | **banned**; descriptor combinators + lint | native `Effect.all` / `race` / `forkChild` / `forEach` |
| Durable sleep | `ctx.sleep(d)` | `yield* sleep(d)` | `Restate.sleep(d)` | `Effect.sleep(d)` |
| Durable timeout | `promise.orTimeout(d)` | `race([work, sleep])` | `Restate.timeout` | `Effect.timeout(d)` |
| Retry with durable backoff | roll your own | roll your own | banned | `Effect.retry(Schedule…)` |
| Cancellation | catchable `TerminalError` | catchable `TerminalError` | interruption | interruption (not catchable) |
| Typed errors | `TerminalError` | `TerminalError` | Schema-encoded domain errors | Schema-encoded domain errors |
| Dependency injection | your own | your own | Effect `Layer` | Effect `Layer` |
| Peer dependency on `effect` | no | no | yes | yes (4.x) |

## When to use which

**Promise SDK** — the default. No extra concepts, no extra dependency, and the
one every Restate example is written in. Reach for something else only if you
are already invested in generators or in Effect.

**`restate-sdk-gen`** — generator DSL with its own cooperative scheduler. Same
determinism mechanism as this package (journaled interleaving), without an
Effect dependency, and with cancellation that a handler can catch and recover
from. Its concurrency vocabulary (`spawn`, `select`, `Channel`, `interrupt`) is
its own rather than a standard library.

**A thin Effect binding** (e.g. `@overeng/restate-effect`) — the minimal,
faithful way to use Effect on Restate: wrap each durable operation in one
`Effect.callback`. It has to *forbid* Effect concurrency over durable
operations, because Effect's fiber interleaving would otherwise be decided by
wall-clock timing and diverge on replay. Parallel work goes through
descriptor-based combinators, and a lint rule keeps `Effect.fork`/`Effect.race`
away from durable operations. If you want Effect's ergonomics with the smallest
possible runtime surface, this is the honest trade.

**This package** — the same Effect ergonomics without the ban. It installs its
own Effect `Scheduler` and a journal multiplexer, so fiber scheduling becomes a
function of journaled decisions rather than of timing (see
[DESIGN.md](./DESIGN.md) §2–3). What you get:

- native Effect concurrency over durable operations, including `forkChild`,
  `race`, concurrent `all`/`forEach`, `Queue`, `Semaphore`;
- `Effect.sleep` / `Effect.timeout` / `Effect.retry(Schedule)` as durable
  primitives, because the invocation's `Clock` is journaled;
- one `Layer` for application services, one journaled `Clock`/`Random`/`Logger`
  per invocation;
- a pipeable `restate.activity` boundary that journals typed failures while
  leaving defects to Restate's technical retry policy;
- a runtime check that catches the one remaining user error (raw async in
  handler code) instead of leaving it to a lint rule.

What it costs:

- a peer dependency on `effect` 4.x, and a hard dependency on Effect's
  `Scheduler` contract, which is a pre-release API;
- cancellation you cannot catch and recover from (see
  [SHARP-EDGES.md](./SHARP-EDGES.md));
- one journal combinator entry per delivery while several durable operations
  are pending — sequential code pays nothing.

## What about Effect's own `unstable/workflow`?

Effect 4 ships a durable-execution API of its own, under `unstable/`:
`Workflow.make({ name, payload, success, error })`, `Activity.make(...)` for
journaled steps with attempt tracking, plus `DurableDeferred`, `DurableClock`
and `DurableQueue`. Execution is delegated to a `WorkflowEngine` service —
`register`, `execute`, `interrupt`, `resume`, `activityExecute`,
`deferredResult`, `scheduleClock` — and `unstable/cluster` provides
`ClusterWorkflowEngine`, an implementation backed by Effect's own sharding and
message storage.

That is a different layer from this package, not a competitor to it:

- **Effect's Workflow API** asks you to write in a workflow vocabulary —
  workflows, activities, durable deferreds — and can then run on any engine.
- **This package** makes *plain Effect* durable. Its `activity` operator is only
  the external-I/O boundary; `Effect.sleep` is still the timer, `Effect.retry`
  is the domain retry, and `Effect.forkChild` is the background task.

The two could meet: a `WorkflowEngine` implementation backed by Restate is a
plausible separate package (`register` → a Restate workflow service,
`activityExecute` → `ctx.run`, `deferredResult` → a durable promise,
`scheduleClock` → `ctx.sleep`, `interrupt` → cancellation). It is deliberately
out of scope here — the API is still `unstable/`, and adopting it would trade
away exactly the property this package exists for. Revisit when Effect's
workflow API stabilizes.

## Interoperability

Contracts are `restate.iface` descriptors from
`@restatedev/restate-sdk-core`, so:

```ts
// contract package
export const Greeter = restate.iface.service("greeter", { greet: ... });

// implemented with this SDK
export const greeter = restate.implement(Greeter, { greet: ... });

// called from a gen handler
const greeting = yield* client(Greeter).greet("world");

// called from a promise handler
const greeting = await ctx.serviceClient(Greeter).greet("world");
```

Effect services can also be bound to an endpoint that serves handlers written
with the other SDKs:

```ts
restate.serve({
  services: [...restateEffect.bind({ services: [greeter], layer: AppLayer })],
});
```

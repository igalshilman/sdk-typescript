# Sharp edges

Things that will bite, and what to do instead.

## Raw async in handler code is illegal

`Effect.promise`, `Effect.tryPromise` and `Effect.callback` wake a fiber from
outside the journal. Nothing after such a wake is replay-stable, so the runtime
refuses it: the first journal operation created after a foreign wake fails the
invocation with

```
unjournaled async detected — the durable operation "…" was created while no
fiber should have been running.
```

The fix is always the same: move the async work inside `restate.run`, where the
real world is allowed.

The check is **best-effort**, so do not rely on it to find these for you. It
fires on the *journal operation*, not on the wake, and three cases slip past:

- a foreign wake that never touches the journal (it cannot diverge a replay by
  itself, but it can leave a handler hanging);
- a raw `Promise` continuation that lands *during* a drain — at the journal call
  site it is indistinguishable from work the journal woke;
- a `forkDetach` fiber creating entries after the invocation ends.

All three are rule-1 violations, so determinism still holds for code that obeys
rule 1; what you may not get is the diagnostic. Prefer a library that accepts an
`AbortSignal`, and call it from a `run` closure.

## Cancellation is not swallowable

Restate cancellation maps to interrupting the handler's root fiber. That is the
Effect-native mapping — `acquireRelease` releases, `Scope` finalizers run,
saga compensations run in order, `uninterruptible` regions are honoured — but
it means a handler **cannot catch cancellation and return a success value**, as
a `restate-sdk-gen` or promise-SDK handler can. `Effect.catch` does not observe
interruption, by design.

If you need catch-and-continue semantics, do the cleanup in a finalizer:

```ts
Effect.acquireRelease(startWork, () => restate.run("cleanup", cleanup()))
```

Finalizers may perform journal operations; the driver keeps running until they
finish, and their entries land inside the invocation.

## `forkDetach` escapes the invocation

`forkChild` and `forkScoped` fibers are interrupted and finalized before the
invocation completes. `forkDetach` fibers are not: they keep running after the
handler returns, and any journal operation they attempt then is both
meaningless and detected as unjournaled async. Do not use `forkDetach` in a
handler.

## Sync clock reads are per-attempt, and some operators use them

`Clock.currentTimeMillis` (the effectful read) is journaled.
`clock.currentTimeMillisUnsafe()` — what Effect's own logger uses for
timestamps — cannot be: nothing can await inside a synchronous getter. It
serves a value frozen at attempt entry, which means it *changes between
attempts of the same invocation*. Use it for diagnostics only.

The catch is that **not every Effect operator uses the effectful reads**.
In `effect@4.0.0-rc.112` these read the clock unsafely, so under this
runtime they see the frozen base and measure **zero elapsed time**:

| Operator | Effect under this runtime |
|---|---|
| `Effect.timed`, `Effect.timedWith` | duration is always ~0 |
| `Schedule.toStepWithMetadata` | elapsed-time metadata is always 0 |
| `Cache`, `ScopedCache` | TTL never appears to expire within an attempt |
| `Pool`, `RcMap` | idle-based reclamation does not fire |
| several `Stream` time operators | windows do not advance |

What *is* supported, and covered by tests:

- `Effect.sleep`, `Effect.timeout`, `Effect.race` over durable operations
  — durable timers, replayed from the journal;
- `Schedule` **delays** (`Schedule.exponential`, `spaced`, `fixed`, …) via
  `Effect.retry`/`Effect.repeat` — the delay goes through `Clock.sleep`,
  so it is a durable timer. Only schedules whose *decisions* depend on
  measured elapsed time are affected;
- `Clock.currentTimeMillis` / `currentTimeNanos` — journaled reads.

To measure elapsed time, read the journaled clock yourself:

```ts
const started = yield* Clock.currentTimeMillis;
yield* work;
const elapsed = (yield* Clock.currentTimeMillis) - started;
```

Absolute-time schedules are the sharper corner: a schedule that compares
against a *frozen* base gets a different base on each attempt. Drive
anything like that from a journaled read or a durable timer.

## Every durable operation must be created in a deterministic order

The runtime guarantees that fibers wake in journaled order, which makes
*concurrency* deterministic. It cannot make your own nondeterminism
deterministic: `if (Math.random() > 0.5)`, iterating a `Set` built from an
unordered source, or branching on `restate.isProcessing` will diverge. Rule 2
in the README covers the common cases.

## A call you hold to await later has not started

Restate delivers to a target in the order the journal entries were *created*, so
entry order is semantics: two calls to the same virtual object arrive in that
order. Effects are lazy, so `restate.call(...)` on its own creates nothing — the
entry appears when the effect runs. Translating the promise-SDK idiom literally
therefore reorders the journal:

```ts
// WRONG: `first` has not started, so the send's entry is created first
const first = restate.call({ service: "Target", method: "append", ... });
yield* restate.send({ service: "Target", method: "append", ... });
yield* first;
```

`Effect.forkChild` does not fix it either: the child is *scheduled*, not run, so
the parent's next operation still gets the earlier entry. Forking buys
concurrency, never entry order.

Use `Effect.all` — it starts children in array order, so entry order follows the
list, and it mixes calls and sends freely:

```ts
yield* Effect.all(
  [
    restate.call({ ... }), // entry 1
    restate.send({ ... }), // entry 2
    restate.call({ ... }), // entry 3
  ],
  { concurrency: "unbounded", discard: true }
);
```

`test/entry-order.test.ts` pins all of this down.

## Wide fan-outs cost journal entries

With N durable operations pending concurrently, each delivery costs one
combinator entry — the price of journaling the interleaving. Sequential code
costs nothing extra (a single pending operation is awaited directly). A fan-out
of thousands of concurrent steps is therefore expensive; batch inside a `run`,
or bound the concurrency.

## `uninterruptible` + suspension

An `uninterruptible` region parked on a durable operation cannot be interrupted
by cancellation until it finishes, which is the point. But if the *attempt*
suspends inside such a region, the in-memory fibers are discarded without
running finalizers (suspension is not interruption — the invocation continues
in a later attempt and replay rebuilds everything). Do not treat an
`uninterruptible` block as a guarantee that a finalizer runs "soon"; treat it as
a guarantee about ordering within an attempt.

## A `run` closure cannot use Restate operations

By design: its result is one journal entry, and nested entries would be
invisible to the driver. The type system enforces it — a `run` whose closure
requires a Restate capability produces an unsatisfiable requirement named
`RestateOperationsAreNotAllowedInsideRun`.

## Handler `E` must be declared to be encodable

A handler whose effect can fail needs `error:` in its options. Without it, a
typed failure is treated as a defect and the attempt is retried — which is
safe, but rarely what you meant.

## Effect 4 is pre-release

This package pins one Effect RC for development and expresses a conservative
peer range. Effect's runtime internals (the `Scheduler` /
`SchedulerDispatcher` contract in particular) are what make this SDK possible;
they may still move. All version-coupled code is in
`src/internal/effect4.ts`, and [DESIGN.md](./DESIGN.md) §8.1 lists every
behaviour we rely on, so a suspicious RC bump can be re-verified against that
table.

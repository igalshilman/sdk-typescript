# restate-sdk-effect — Design

A deep integration between [Effect](https://effect.website) and Restate:
Effect programs — including `Effect.forkChild`, `Effect.race`, concurrent
`Effect.all`, `Queue`, `Deferred`, `Semaphore`, `Schedule` — run durably
on Restate with replay determinism guaranteed by construction, not by
lint rules or restricted combinators.

Status: **implemented**; this document is the reference for *why* it works.
Package: `@restatedev/restate-sdk-effect` in
`packages/libs/restate-sdk-effect`. `effect` (**4.x**) and
`@restatedev/restate-sdk` are peer dependencies. Work breakdown and current
state: [TODO.md](./TODO.md).

Where the design lives in the code:

| Design | Code |
|---|---|
| §3.1 deterministic scheduler, and every other Effect-runtime dependency | `src/internal/effect4.ts` |
| §3.2 journal multiplexer, §3.4 settlement classification, §5 detector | `src/internal/driver.ts` |
| §3.3 per-invocation runtime, handler entry point | `src/internal/runtime.ts`, `src/internal/app-runtime.ts` |
| the journal seam (§10) | `src/internal/lib.ts`, `src/internal/default-lib.ts` |
| §6 authoring surface | `src/define.ts`, `src/run.ts`, `src/ops.ts`, `src/client.ts`, `src/endpoint.ts` |
| §6.3 serde, §7 error boundary, §6.4 capabilities | `src/serde.ts`, `src/errors.ts`, `src/context.ts` |
| §2 replay-equivalence evidence | `test/replay.test.ts` (fuzzed), `e2e/*.e2e.test.ts` |

---

## 1. Positioning

Two prior arts frame this design:

**`restate-sdk-gen`** (in this repo) proves the core mechanism. It runs
user generators on its own cooperative fiber scheduler whose *single
async suspension point* is one `RestatePromise.race` over all parked
journal sources per tick (scheduler invariant S1). Because the SDK
journals combinator completion order, the winner of each race — and
therefore the entire fiber interleaving — is recorded in the journal and
replayed exactly. Concurrency over durable ops is deterministic because
*the interleaving itself is journaled*.

**`@overeng/restate-effect`** (github.com/overengineeringstudio/effect-utils)
is a thin, faithful Effect binding. It wraps each durable op in one
`Effect.callback` await and gets a lot right: a Schema-based serde with
slot-aware error classification, a typed error boundary (domain errors →
`TerminalError` with Schema-encoded body; infra failures → defects),
capability markers in `R`, journaled `Clock`/`Random`, a
`Logger → ctx.console` bridge, and a cancellation ↔ interruption bridge.
But it deliberately **forbids Effect concurrency over durable ops**
(decision 0005): parallel durable work goes through descriptor-based
`Restate.all/race/any` combinators, raw `Effect.fork`/`Effect.race` over
durable ops is lint-flagged, and a `Clock.sleep → ctx.sleep` remap was
rejected because `Effect.timeout` internally races against `Clock.sleep`
— the exact fiber-interleaving hazard they cannot make deterministic.

Their own words state the problem precisely: *"nondeterministic fiber
interleaving over durable ops produces nondeterministic journal order →
replay divergence"*, and the descriptor shape exists *"instead of
betting correctness on Effect's (single-threaded but internal)
fiber-scheduling order."*

This package removes that bet. We lift `restate-sdk-gen`'s
journaled-interleaving mechanism *under* Effect's runtime: a
deterministic scheduler plus a journal-anchored completion multiplexer
make Effect's fiber scheduling a pure function of journaled decisions.
Then the combinators `@overeng/restate-effect` had to ban become the
selling point, and the ones it had to invent (descriptors) become
unnecessary.

What we adopt from them, what we replace:

| Layer | @overeng/restate-effect | restate-sdk-effect |
|---|---|---|
| Concurrency over durable ops | banned; descriptor `Restate.all/race/any` + oxlint | native `Effect.forkChild/race/all/…` via deterministic runtime |
| Durable sleep / timeout | explicit `Restate.sleep`/`Restate.timeout` only; `Clock.sleep` remap rejected | `Clock.sleep → ctx.sleep` remap; `Effect.sleep`, `Effect.timeout`, `Schedule` delays are durable |
| `Effect.retry` over durable steps | banned (Restate owns retries) | allowed and meaningful: domain-level retry with durable backoff (infra retry stays `ctx.run`'s) |
| Journaled `Clock` reads / `Random` via `ctx.rand` / frozen sync-time base | ✓ | adopt |
| `Logger → ctx.console` bridge (replay-suppressed) | ✓ | adopt |
| Error boundary (domain E → TerminalError body; defects → retry; slot-aware serde; suspension verbatim) | ✓ | adopt (§7) |
| Capability markers in `R` (`StateRead`, `StateWrite`, …) | ✓ | adopt (§6.4) |
| Contract / implement split | own contract layer | reuse `restate-sdk-core`'s `iface` Descriptors — Effect services interop with gen- and promise-SDK clients |
| Packaging | bundles `restate-sdk`, targets effect 4.0-rc | peer deps on `effect` (**4.x**) + `restate-sdk`; monorepo conventions |

---

## 2. The determinism problem

Restate's replay contract: on retry/resume the handler re-executes from
the top; journal entries must be *created* in the same order as the first
execution, and awaited results are served from the journal. Two facts
about the TS SDK anchor the design:

1. **Entry creation is synchronous** at the `ctx.*` call site. Whoever
   controls the order of user-code execution controls journal order.
2. **Combinators journal completion order.** `RestatePromise.all/race/any/
   allSettled` hand the VM an unresolved-future tree
   (`CombinatorRestatePromise.unresolvedFuture()`), and the shared core
   records which child settled the combinator. A replayed race resolves
   to the *same winner* regardless of real-world timing.

Why a naive Effect binding breaks under concurrency: Effect's runtime is
single-threaded and cooperative, so fiber interleaving is deterministic
*given the order in which external completions arrive*. But completion
order differs between first execution (real-world timing) and replay
(journal serves everything immediately). Two fibers awaiting two
`ctx.run`s wake in timing order on first execution and in SDK-internal
resolution order on replay; every journal entry they create *after*
waking is now potentially transposed → journal mismatch.

`restate-sdk-gen`'s answer, which we reuse: never let a raw completion
wake user code. Park all pending journal sources, `RestatePromise.race`
them (journaled), deliver exactly the recorded winner, repeat. Wake order
is replayed from the journal; everything downstream of wake order —
including all in-memory fiber interleaving — is then deterministic.

---

## 3. Architecture

Three pieces, all per-invocation: a **deterministic scheduler** (controls
*when fibers run*), a **journal multiplexer** (controls *when completions
arrive*), and a **runtime layer** (controls *what ambient services
resolve to*).

```
        handler Effect (user code, any combinators)
                          │
        ┌─────────────────┴──────────────────┐
        │  per-invocation Effect runtime      │
        │  Clock/Random/Logger → ctx-backed   │
        │  RestateContext + capability tags   │
        └─────────────────┬──────────────────┘
                          │ fibers step only via
        ┌─────────────────┴──────────────────┐
        │  deterministic scheduler (FIFO)     │  ← Effect Scheduler impl
        └─────────────────┬──────────────────┘
                          │ parks on journal sources,
                          │ woken only by
        ┌─────────────────┴──────────────────┐
        │  journal multiplexer                │
        │  await RestatePromise.race(pending) │  ← journaled winner
        └─────────────────┬──────────────────┘
                          │
                    restate.Context
```

### 3.1 Deterministic scheduler

An implementation of Effect 4's `Scheduler` interface:

```ts
interface Scheduler {
  readonly executionMode: "sync" | "async";
  shouldYield(fiber: Fiber<unknown, unknown>): boolean;
  makeDispatcher(): SchedulerDispatcher;      // { scheduleTask(task, priority); flush() }
}
```

Ours is `executionMode: "sync"`, `shouldYield: () => false` (no
involuntary op-budget yields), and — the key move — `makeDispatcher()`
returns **one shared dispatcher for the whole invocation**. Effect 4
creates a dispatcher *per fiber*, lazily
(`fiber._dispatcher ??= fiber.currentScheduler.makeDispatcher()`), so
handing every fiber the same instance recovers exactly what
`restate-sdk-gen` owns outright: a single global FIFO task queue for the
invocation. Installation is via the scheduler service reference
(`Context.make(Scheduler.Scheduler, ours)`, a fiber-cached
`Context.Reference` — so children inherit it) or `RunOptions.scheduler`;
both verified.

The multiplexer drains that queue synchronously (`flush()`), interleaved
with microtask turns, until quiescence — "no fiber can make progress" is
observable as an empty queue that a microtask turn does not refill. Since
JS is single-threaded and every fiber step is a task in this one queue,
fiber interleaving is a deterministic function of (program,
completion-delivery order).

### 3.2 Journal multiplexer

Every durable op issues its `RestatePromise` **synchronously at the call
site** (deterministic creation order, fact 1 in §2), registers it as a
*source*, and suspends the calling fiber on an in-memory notification —
the SDK promise is never awaited directly by user-facing code.

The multiplexer loop (plain JS, outside the Effect runtime — the
counterpart of `Scheduler.run` in gen):

```
drain scheduler to quiescence
while handler fiber not done:
  sources ← pending registered sources
  if sources is empty  → stuck: fail fast (deadlock diagnostic, like gen)
  if |sources| = 1     → await it directly            (no combinator entry)
  else                 → await RestatePromise.race(tagged sources)   (journaled winner)
  classify the settlement (§3.4) and deliver it to the owning fiber
  drain scheduler to quiescence
```

On replay the same program issues the same sources in the same order, the
race entries replay their recorded winners, deliveries repeat in the same
order, and the interleaving reproduces exactly. Re-racing a losing source
in later ticks is proven safe by gen (its `parkedSources()` are
re-collected and re-raced every iteration, exercised by its e2e suite).

Interruption interacts cleanly: when Effect interrupts a fiber parked on
a source (a race loser, a scope teardown), an `onInterrupt` hook
deregisters the source and aborts that fiber's in-flight `run`
`AbortSignal`. Deregistration happens inside deterministic fiber
execution, so the pending-source set — and therefore each race's children
— is replay-stable. The underlying journal entry still completes
whenever it completes; nobody reads it (same as gen's race losers).

### 3.3 Per-invocation runtime layer

The endpoint builds one `ManagedRuntime` from the user's application
`Layer` (DB pools, config — built once per process, shared across
invocations, same discipline as `@overeng/restate-effect`'s AppR). Each
invocation forks the handler effect with invocation-scoped overrides:

- **`Clock`** — `currentTimeMillis`/`currentTimeNanos` read
  `ctx.date.now()` (journaled). The sync reads
  (`currentTimeMillisUnsafe`/`currentTimeNanosUnsafe`/
  `monotonicTimeNanosUnsafe`, v4 names) serve a per-attempt frozen base
  seeded once at handler entry (adopted from overeng decision 0004 — a
  replayed attempt must observe the time it first observed).
  **`sleep` maps to `ctx.sleep`** — see §4.
- **`Random`** — backed by `ctx.rand` (seeded on invocation id;
  replay-stable given deterministic consumption order, which §3.1
  provides).
- **`Logger`** — Effect's logfmt format, sink swapped to the replay-aware
  `ctx.console` (adopted from overeng decision 0015): one emission per
  logical log, level control via `RESTATE_LOGGING`.
- **`RestateContext`** tag (the raw `restate.Context`) plus capability
  markers per handler kind (§6.4).
- The deterministic scheduler (§3.1).

`FiberRef`s work unchanged and are deterministic under this runtime —
they subsume gen's `contextLocal` with better semantics (per-fiber
inheritance instead of one shared bag).

### 3.4 Settlement classification

Adopted from overeng's `awaitDurable` seam, applied at the multiplexer's
single delivery point:

| Settlement | Action |
|---|---|
| value | deliver to owning fiber |
| source rejection: `TerminalError` (non-cancel) | deliver as failure — flows through the error boundary (§7) |
| aggregate race rejection: `CancelledError` | abort current run-signals (then replace — non-sticky, as in gen), interrupt the **root** fiber; Effect's structured concurrency propagates, finalizers run (and may perform journal work — the journal is not poisoned) |
| suspension error (`restate.internal.isSuspendedError`) | halt the multiplexer, rethrow **verbatim** out of the handler. No interruption, **no finalizers** — the attempt is ending but the invocation continues in a later attempt (overeng R15); in-memory fiber state is simply discarded, and replay rebuilds it |
| `attemptCompletedSignal` fires | stop driving, abort in-flight run-signals (parent-signal linkage, as in gen's `execute`) |

Mapping invocation cancellation to *root interruption* (instead of gen's
per-fiber error fan-out) is the Effect-native choice: `acquireRelease`,
`Scope` finalizers, and saga compensations run in guaranteed order, and
uninterruptible regions are honored. The handler then completes with a
`CancelledError` reported to the SDK.

### 3.5 Journal cost model

- Sequential code (the common case): zero overhead. One pending source →
  direct await, no combinator entry — identical journal shape to the
  plain SDK and to a thin binding.
- N concurrently-parked sources: one race combinator entry per delivery.
  This is the price of journaled interleaving, the same price gen pays in
  its fallback path. Acceptable for v1; a batched-delivery optimization
  (deliver multiple already-settled sources per tick in journaled order)
  is future work and is invisible to user code.

---

## 4. `Clock.sleep → ctx.sleep`: why the remap is right here

Overeng rejected the remap for two reasons; the deep runtime dissolves
one and converts the other:

1. *"`Effect.timeout` internally races `Clock.sleep` — nondeterministic
   interleaving."* Races are deterministic here. `Effect.timeout` over a
   durable step becomes a **durable timeout** — exactly what a user wants
   it to mean.
2. *"Library/app-layer sleeps would silently journal durable timers."*
   In this architecture a non-durable in-handler sleep **cannot exist**:
   a `setTimeout` wake is an unjournaled external event — precisely the
   nondeterminism the multiplexer excludes (§5). Every wake must come
   from the journal, so every sleep must be a durable timer. This is also
   the semantically correct behavior for durable handlers: an in-process
   timer that doesn't survive suspension is almost always a bug. Code
   that genuinely needs wall-clock waiting belongs inside `Restate.run`,
   where real async is legal.

Consequences that fall out for free: `Effect.sleep("30 minutes")`
suspends the invocation; `Effect.retry(Schedule.exponential("1s"))`
around a `Restate.run` is a **durable domain-level retry** (each attempt
a fresh journaled step, each backoff a durable timer, resumable
mid-backoff) — cleanly layered *above* `ctx.run`'s own infra retry
policy, which remains the tool for transient step failures.

---

## 5. The user contract (all three rules)

Everything the deterministic runtime cannot see must go through the
journal. The rules reduce to:

1. **All real-world async goes through `Restate.run`.** Raw
   `Effect.promise`/`tryPromise`/`Effect.callback` in handler code is
   illegal (it wakes fibers from outside the journal). Inside a
   `Restate.run` closure, anything goes — it executes on the *application
   runtime* (real Clock, real scheduler) and only its journaled result
   re-enters the deterministic world.
2. **No unsafe sync nondeterminism in handler code** (`Date.now()`,
   `Math.random()`, `crypto.randomUUID()`) — the journaled `Clock`,
   `Random`, and `Restate.run` cover every idiom.
3. **Journal-crossing values must be serializable** (Schema-governed;
   §6.3).

Everything else — any Effect combinator, any concurrency structure — is
unconstrained. Rule 1 is also *partly* machine-checkable at runtime, and
being precise about "partly" matters more than the check does. The check
is on journal ops, not on wakes: **a journal op created while the
multiplexer is parked (i.e. outside a drain) is the product of a wake the
journal did not cause.** We own every journal call site, so that case
dies with a pointed diagnostic ("unjournaled async detected — wrap it in
Restate.run") instead of surfacing as journal corruption three days
later.

It is **best-effort, not complete**, and two holes are known (probed by
`codex@effect-restate-review`, 2026-09-02):

- a raw `Promise` continuation that lands *during* a drain is
  indistinguishable, at the journal call site, from work the journal
  woke — so an entry it creates is not flagged;
- a `forkDetach` fiber outlives the invocation (§8.1) and can create
  entries after the root exits, which the detector does not see either.

Neither weakens the determinism guarantee, because that guarantee is
conditional on rule 1 and both cases *are* rule-1 violations. What they
mean is narrower and worth stating plainly: **a handler that breaks rule
1 may get no diagnostic.** Hardening the check is tracked separately;
promising more than it delivers would be worse than the gap.

Two supplementary signals catch such wakes earlier — a dispatcher task
enqueued while parked, and a fiber exit observed while parked. Note that
in Effect 4 a foreign wake alone is *not* visible as a dispatcher task:
`Effect.callback`'s `resume` re-enters the fiber synchronously rather
than scheduling it (verified), which is why the primary check is anchored
on journal ops. `Fiber.currentOpCount` is not a usable probe either — it
resets per execution slice. Overeng needed an oxlint rule as an advisory
backstop; we get a hard runtime check on the thing that can actually
corrupt a journal.

---

## 6. Public API sketch

### 6.1 Authoring

Handlers are `(input) => Effect<Output, DomainError, R>`. The factories
mirror this repo's existing shapes and produce
`Implemented*Definition`s binding into `restate.serve`/`endpoint` like
any other service, with contracts declared via `restate-sdk-core`'s
`iface` descriptors — so an Effect service is callable from gen- and
promise-SDK clients and vice versa:

```ts
import { Effect, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

class EmptyName extends Schema.TaggedError<EmptyName>()("EmptyName", {}) {}

const greeter = restate.service({
  name: "greeter",
  handlers: {
    greet: restate.handler(
      { input: Schema.String, output: Schema.String, error: EmptyName },
      (name) =>
        Effect.gen(function* () {
          if (name === "") return yield* new EmptyName();
          const id = yield* restate.run("gen-id",
            Effect.sync(() => crypto.randomUUID()));
          return `Hello ${name} (${id})`;
        })
    ),
  },
});

// endpoint: application Layer built once; per-invocation runtime on top
restate.serve({ services: [greeter], layer: AppLayer });
```

`iface.*` + `implement` parity with gen follows the same pattern
(`implement` binds Effect handlers to a shared `ServiceDescriptor`).

### 6.2 The `Restate` module surface

Durable primitives that need explicit calls (everything else is ambient
via Clock/Random/Logger or plain Effect combinators):

```ts
run(name, effect, opts?)      // journaled step; effect runs on the app runtime,
                              // R scrubbed of Restate capabilities (compile error
                              // for nested journal ops — overeng's trick)
Effect.exit(run(...))        // observe outcome as Exit (sagas/compensation)
awakeable(schema?)            // { id, await: Effect<T> }
resolveAwakeable / rejectAwakeable
state / sharedState           // Schema-typed K/V (objects, workflows)
key                           // object/workflow key
client / sendClient           // typed RPC via core Descriptors (journal sources)
workflowPromise(name, schema?)
handlerRequest / cancel / attach / signal
```

Deliberately absent: `Restate.sleep`, `Restate.timeout`, `Restate.race`,
`Restate.all`, descriptor variants — plain `Effect.sleep`,
`Effect.timeout`, `Effect.race`, `Effect.all` *are* the durable
combinators here.

The shipped surface adds a few things the sketch did not anticipate:

- `terminalError(message, { code, metadata })` — fail terminally without
  declaring a Schema for the error. The equivalent of
  `throw new TerminalError(...)` in the other SDKs, and what the
  conformance services needed.
- `call` / `send` / `callDetached` — RPC addressed by service and handler
  *name*, for proxies and dispatchers that have no contract to import.
  `callDetached` creates the call entry without awaiting the result.
- `invocation(id).signal(name).resolve/reject` — complete a signal on
  another invocation.
- `RunSignal` — the `AbortSignal` of the surrounding `run`, available
  *inside* the closure (`const { signal } = yield* restate.RunSignal`) so
  real I/O can be cancelled promptly.
- `rawContext` / `durable(name, ctx => RestatePromise)` — the escape hatch
  for SDK features this package does not wrap yet, with `durable` keeping
  the promise registered as a journal source.
- `decodeFailure(schema)` — decode a callee's declared domain error back
  into a tagged error (§7).

### 6.3 Serde

An `effect/Schema ↔ restate.Serde` bridge, adopted from overeng nearly
wholesale, including slot-aware decode-failure classification: an
ingress-input decode failure is a deterministic bad request →
`TerminalError(400)`; an internal-slot failure (state, run result,
awakeable payload) is corrupt-journal infra → defect/retry. JSON schema
derivation for discovery comes from the Schema.

As implemented, the slot-aware part needs no logic of its own: the
promise SDK already maps a *handler-input* decode failure to
`TerminalError(400)`, and a failure on any internal slot propagates as a
defect and retries the attempt. One `schemaSerde` therefore behaves
correctly everywhere. Two details that are not obvious:

- encode/decode must go through the Schema (`encodeSync` /
  `decodeUnknownSync`), not `JSON.stringify`, or transformations
  (`Schema.Class`, dates, branded types) silently round-trip wrong;
- a Schema that accepts *nothing* (`Schema.Void`, anything optional) must
  **not** advertise a JSON Schema. `Schema.Void` renders as
  `{"type":"null"}`, and Restate's ingress then rejects an empty body
  ("Empty body not allowed"). Suppressing the JSON Schema for such
  handlers reproduces the promise SDK's own `void`-handler discovery
  shape.

### 6.4 Capability markers

Adopted from overeng decision 0002: flat marker tags in `R` —
`StateRead`, `StateWrite`, `DurablePromise`, `ObjectKey` — provided by
each construct's materialization (exclusive object handlers get
`StateRead | StateWrite`; shared get `StateRead`; workflow `run` gets the
full set). Illegal ops (writing state in a shared handler) are compile
errors. `Restate.run` scrubs all of them plus `RestateContext` from its
inner effect's `R`, so journal ops inside a run closure don't typecheck.

---

## 7. Error boundary

Adopted from overeng decision 0003, unchanged in substance:

- Handler `E` carries **declared domain errors only** (Schema-encodable
  tagged errors). At the boundary they encode into a `TerminalError`
  whose message body is the Schema-encoded JSON (+ `_tag`), with
  per-error `errorCode`; typed clients decode them back for `catchTag`.
- **Defects → retryable**: rethrown non-terminal, Restate retries the
  attempt. A failure that doesn't match the declared error schema is a
  defect (classification drift never silently mis-encodes).
- **Interruption → `CancelledError`** (not retried).
- `Restate.run`'s inner effect is `Effect<A, never, R>` (clean E; die
  inside the step to force an infra retry; observe with `Effect.exit` for
  sagas). Typed-failure transport through `run` (journaling an encoded
  `Exit`) is deferred, as overeng also concluded.
- Awakeable/durable-promise rejections terminalize **verbatim**.

## 8. Concurrency semantics (the contracts users rely on)

- **`Effect.forkChild`** (v4's structured fork; there is no bare
  `Effect.fork` in effect 4): standard Effect semantics — child scoped to
  parent; when the parent exits, children are interrupted and finalizers
  run. Because interruption is Effect-native, there is no gen-style
  abandoned-without-finally state during normal execution.
- **`Effect.race` / `raceFirst`**: losers are interrupted (sources
  deregistered, run-signals aborted, finalizers run). Note this is
  *stronger* than gen's race (whose losers keep running until main
  settles).
- **End of invocation**: leftover `forkChild` / `forkScoped` fibers are
  interrupted and *driven to completion* (interrupt-then-join), so their
  finalizers' journal writes land inside the invocation. This is Effect's
  own behaviour, not ours: a root fiber's `Exit` is withheld until its
  descendants have finished, even when a finalizer parks on a fresh
  durable operation (verified, §8.1). It differs from gen's default
  `abandon`, and it is bounded because interruption forces exit everywhere
  except uninterruptible non-terminating regions (documented sharp edge).
  `forkDetach` is the exception and is **not supported**: a detached fiber
  outlives the invocation, so its journal ops would land after the
  handler returned — the detector reports it rather than corrupting the
  journal silently.
- **In-memory coordination** (`Deferred`, `Queue`, `PubSub`, `Semaphore`,
  `STM`, `FiberRef`): fully supported, deterministic under §3.1. This
  subsumes gen's single-shot `Channel` with the real toolbox.

### 8.1 Runtime semantics (verified against effect 4.0.0-rc.112)

Interruption is Effect's third outcome channel (`Exit` is success,
failure, or a `Cause` carrying an interrupt) and is cooperative —
delivered at yield points, never mid-synchronous-op — the structured
counterpart of gen's "throw at the next yield". Each row below was
verified empirically against `effect@4.0.0-rc.112` with throwaway lab
scripts (not checked in — a scheduler/interruption lab, a
foreign-wake/detector lab, and a typecheck smoke test compiled under this
repo's compiler flags); re-create them from this table if a claim needs
re-proving after an RC bump:

| Verified behavior (effect 4.0.0-rc.112) | Design implication |
|---|---|
| A custom `Scheduler` whose `makeDispatcher()` returns one shared dispatcher receives **every** fiber task — root and `forkChild` descendants alike; the handler runs to completion inside our synchronous `flush()` | §3.1's premise holds: we own the queue without owning the fiber runtime |
| Concurrent `Effect.forEach(concurrency: "unbounded")` interleaves identically across runs under our drain (needs a microtask turn between flushes) | §3.2's drain shape; determinism of in-memory interleaving |
| Interrupt lands as `Exit` failure with interrupts only; `Effect.catch` does **not** observe it | interruption cannot be swallowed by user error handling; the boundary reliably reports `CancelledError` |
| Finalizer order on interrupt: `Effect.callback` canceler → `onInterrupt` → `acquireRelease` release → `ensuring` (innermost-first) | cancellation cleanup = ordinary finalizers; they may contain journal ops (the journal is not poisoned — §3.4) |
| `Effect.uninterruptible` defers delivery; the fiber stays alive while shielded and still ends interrupted | handlers can shield critical sections (e.g. a compensation sequence) from mid-flight cancellation |
| `Effect.callback`'s canceler runs when the parked fiber is interrupted | exactly the multiplexer's source-deregistration hook (§3.2) — no extra bookkeeping |
| `Effect.race` interrupts the loser; `Queue` hand-off between fibers works under our scheduler | §8's race-loser and in-memory-coordination semantics come from Effect itself |
| Overriding `Clock.Clock` intercepts both `Effect.sleep` **and** `Effect.timeout`'s internal timer | §4's remap is real: `Effect.timeout` becomes a durable timeout for free |
| The scheduler can be installed as a fiber-cached `Context.Reference` (`runForkWith(Context.make(Scheduler.Scheduler, ours))`) as well as via `RunOptions.scheduler` | clean composition with a process-wide `ManagedRuntime` (§3.3) |
| `shouldYield: () => false` with `executionMode: "sync"` produces **zero** involuntary yields: 20 000 sequential ops complete inside `runFork` without scheduling one task | `MaxOpsBeforeYield` / `PreventSchedulerYield` are not needed; also, a handler with no durable ops finishes before the driver's first tick |
| `Queue`, `Semaphore`, `Pool` and `Schema` all behave under the shared dispatcher — including a `Queue` produced into by a fiber that is then interrupted and consumed by another | the data structures that capture `fiber.currentDispatcher` are consistent because there is only one dispatcher |
| A root fiber's `Exit` is withheld until its `forkChild`/`forkScoped` descendants finish — including a finalizer parked on something asynchronous | "root fiber settled" is a *complete* stop condition for the driver: interrupt-then-join (§8) is Effect's own behaviour, not something we implement |
| `forkDetach` fibers are **not** interrupted when the root exits | detached fibers escape the invocation and can journal after it ends — unsupported, documented as a sharp edge |
| `RunOptions.onFiberStart` fires for the **root fiber only**, not descendants | there is no way to maintain a fiber registry; the §5 detector must not depend on one (it does not — it is anchored on journal ops) |
| One `ManagedRuntime.make(appLayer)` plus `await runtime.context()` gives a memoized `Context` that per-invocation overrides merge onto; overrides are inherited by forked children and isolated per invocation | §3.3's layering costs one small context per invocation, not a layer build |
| `Effect.all(concurrency: "unbounded")` starts its children in **array order**, so journal entries are created in list order even when parking and synchronous ops are mixed; `Effect.forkChild` alone creates **nothing** (the child is scheduled, not run) until the parent yields | entry-creation order is expressible, and `Effect.all` is the way to express it. Restate orders deliveries to a target by entry creation, so this is semantics: see `test/entry-order.test.ts`, and the sharp edge on holding a call effect to await later |
| `Effect.timed`, `Schedule.toStepWithMetadata`, `Cache`, `ScopedCache`, `Pool`, `RcMap` and several `Stream` operators read the clock through the **unsafe** accessors, not the effectful ones | the frozen per-attempt base is visible to user-facing operators, so `Effect.timed` measures zero. The supported time-sensitive surface is enumerated in SHARP-EDGES and pinned by e2e tests; `Schedule` *delays* are unaffected because they go through `Clock.sleep` |
| `Effect.callback`'s canceler is the only interruption hook a parked fiber gets, and it does not run for a source that settled normally | `park(op, create, onInterrupt)` is enough to tear down the external work behind a journal entry — how a race-loser `Restate.run` aborts its closure. The entry itself is Restate's to complete |

Two v4 deltas versus effect 3, both in our favour or neutral:

- **External interrupt delivery is synchronous.** `fiber.interruptUnsafe()`
  re-enters the fiber immediately (`evaluate(failCause(...))`) rather
  than scheduling a task, unless the fiber is mid-step, in which case
  it is deferred to the run loop. Determinism is unaffected — *we* choose
  the call site, at a fixed point in the tick loop — but the multiplexer
  must keep driving after interrupting, because finalizers can park on
  fresh journal sources (interrupt-then-join).
- **A foreign wake is invisible to the dispatcher** (`Effect.callback`'s
  `resume` also re-enters synchronously), which is why §5's detector is
  anchored on journal-op creation rather than on task enqueues.

This preserves the clean invariant: **every interrupt in the system
originates deterministically.** Fiber-initiated interrupts (race losers,
scope teardown, explicit `Fiber.interrupt` in user code) are ordinary
deterministic execution; the only external initiator is the multiplexer
acting on a journaled `CancelledError`, issued at a fixed point in the
tick loop. Replay reproduces both.

One genuine semantic gap versus gen: Restate cancellation is
*swallowable* (gen handlers catch the `TerminalError`, keep working, and
may even return a success value). Effect interruption is not — a fiber
can shield (`uninterruptible`) and clean up (finalizers), but once
interrupted it cannot resume the main line and produce a success. The
default mapping (cancellation → root interrupt) therefore trades gen's
catch-and-continue for structured teardown. An opt-in cooperative mode
can restore it: `Restate.cancellation` — an effect that completes when
cancellation arrives — raced by the handler on its own terms, with the
hard interrupt withheld (per-service or per-handler config). Whether to
ship that in v1 is open question 6.

Restate **suspension is not interruption** (§3.4): finalizers must not
run when an attempt suspends, so the multiplexer never converts a
suspension into an interrupt — it abandons the in-memory fibers and
rethrows verbatim.

Worked example — every combinator below is banned or impossible in the
thin binding, and durable here:

```ts
const process = (order: Order) =>
  Effect.gen(function* () {
    // parallel durable steps — plain Effect.all
    const [user, stock] = yield* Effect.all(
      [restate.run("user", fetchUser(order.userId)),
       restate.run("stock", checkStock(order.items))],
      { concurrency: "unbounded" });

    // durable timeout + durable domain retry — plain Effect operators
    const payment = yield* restate.run("charge", charge(order)).pipe(
      Effect.timeout("30 seconds"),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4 }));

    // background progress reporter, interrupted+finalized at scope end
    const events = yield* Queue.make<string>();
    yield* Effect.forkChild(reportProgress(events));

    // bounded fan-out over durable steps
    yield* Effect.forEach(order.items,
      (it, i) => restate.run(`ship-${i}`, ship(it)),
      { concurrency: 5 });

    return payment.receiptId;
  });
```

---

## 9. Packaging

- `packages/libs/restate-sdk-effect`, public, standard template scripts.
- `peerDependencies`: `effect` **4.x** and `@restatedev/restate-sdk` (as
  gen does).
- `dependencies`: `@restatedev/restate-sdk-core` (descriptors, serde
  plumbing); `@restatedev/restate-sdk-clients` later for an Effect
  ingress client.
- tsdown `external`: `effect`, `@restatedev/restate-sdk`, workspace deps.
- **Pre-release policy.** Effect 4 is at RC (`4.0.0-rc.112`). Dev and
  tests pin an exact RC; the peer range stays conservative
  (`>=4.0.0-rc.112 <5`); a CI job installs the newest 4.x RC on a
  schedule so churn surfaces as a failing build rather than a user
  report. A non-`0.x` release of this package waits for effect 4.0 final.
- The version-coupled seams — scheduler install, dispatcher shape,
  Clock/Random/Logger overrides, runtime fork, interrupt entry point —
  live in one internal module (`src/internal/effect4.ts`), so RC churn
  (and eventually effect 5) touches one file.
- The published types use the **function form** of Effect's context keys
  (`Context.Service<Shape>("key")`) and a plain `Error` subclass for
  `RestateFailure`. Effect's class-factory forms
  (`class X extends Context.Service<X, S>()("key")`,
  `Data.TaggedError`) emit synthetic `X_base` symbols into the `.d.ts`,
  which API Extractor rejects as forgotten exports.

## 10. Testing

- **Unit, Restate-free**: like gen's `AwaitableLib`, the multiplexer
  depends on an abstract lib (`race`, `isCancellation`,
  `isSuspension`); tests wire hand-controlled deferreds and drive
  completions in arbitrary orders.
- **Determinism harness**: run a program with completion order O₁,
  record the delivery sequence; re-run serving completions in the
  recorded order (simulated replay) and assert the journal-op creation
  sequence is byte-identical. Fuzz O₁ across seeds. The §5 foreign-wake
  detector runs in all tests.
- **e2e**: testcontainers suites mirroring gen's (`concurrency`, `saga`,
  `terminal-errors`, `transient-errors`, cancellation, suspension/resume
  mid-`Effect.sleep`, durable-retry resume mid-backoff).
- **Type-level tests** for capability markers and `run` scrubbing
  (overeng's `capability-inference.types.ts` is a good model).

### 10.1 Conformance: test-services + sdk-test-suite

The repo's strongest correctness signal is the official conformance
suite (`restatedev/e2e`'s `sdk-tests.jar`, pinned via the
`restatedev/e2e/sdk-tests@v2.2` GitHub action): a black-box harness that
boots Restate + a service container and drives fixed-name services
through ingress across six execution modes (`default`,
`alwaysSuspending`, `lazyState`, `persistedTimers`,
`singleThreadSinglePartition`, `threeNodes`). Both the promise SDK
(`packages/tests/restate-e2e-services`) and gen
(`packages/libs/restate-sdk-gen/test-services`) ship a service set for
it; gen's precedent is the one to copy — its `exclusions.yaml` is empty
(full conformance).

The Effect variant follows gen's footsteps exactly, one artifact each:

- **`test-services/src/`** — port the conformance service set to Effect
  idiom (~1.5k lines in gen across 16 files): `Counter`, `Proxy`,
  `Failing`, `ListObject`, `MapObject`, `AwakeableHolder`,
  `NonDeterministic`, `CancelTestRunner`/`CancelTestBlockingService`,
  `KillTestRunner`/`KillTestSingleton`, `TestUtilsService`,
  `VirtualObjectCommandInterpreter` (282 lines in gen),
  `BlockAndWaitWorkflow`, and the layered random-program
  `ObjectInterpreterL0/L1/L2` + `ServiceInterpreterHelper` (370 lines in
  gen — effectively a fuzzer over journal ops and concurrency, the
  highest-value test for this package).
- **`test-services/src/server.ts`** — one endpoint binding all services,
  honoring the harness contract: `SERVICES` env filters by name, `PORT`
  (default 9080), `E2E_REQUEST_SIGNING` → `identityKeys`.
- **`test-services/Dockerfile`** — workspace-root build context (pnpm
  workspace symlinks), `pnpm install --frozen-lockfile`, build the lib,
  `tini` as entrypoint, launch via `node --import tsx` (not pnpm — the
  corepack shim phones home at container start and a fetch failure kills
  the endpoint before it binds; gen's Dockerfile documents this).
- **`test-services/exclusions.yaml`** (+ `.env` with `RESTATE_LOGGING`)
  — per-suite skip list; start with exclusions while porting, drive to
  empty. **Empty as of 2026-09-02**: 267 tests across all seven suites of
  `sdk-tests.jar` v2.2, no exclusions. The first run found two bugs the
  in-house e2e suite did not: a service context's `key` getter throws, so
  `handlerRequest` must branch on the handler kind rather than probe it;
  and a call effect held to await later creates no journal entry, so its
  delivery was ordered after a later send's.
- **`.github/workflows/integration-effect.yaml`** — clone of
  `integration-gen.yaml` (which mirrors `integration.yaml`): PR + 6-hour
  cron + `workflow_call` so the restate runtime repo can exercise this
  SDK against runtime commits.
- **`.tools/run-sdk-tests.sh`** — add an `--effect` flag next to `--gen`
  (image tag + Dockerfile path). Local runs need Java 21 + Docker; the
  script pins the suite version by parsing `integration.yaml`.

Why conformance is disproportionately valuable for *this* package:
`alwaysSuspending` suspends between steps, forcing a full replay of the
journal at every step — a standing torture test of the deterministic
interleaving claim (§2–3); `NonDeterministic` verifies journal-mismatch
*detection* still surfaces through our runtime; the kill/cancel tests
black-box-validate the cancellation → root-interrupt mapping.

Compatibility audit (done for the sharpest case): `CancelTestRunner`
catches the `TerminalError(409)` of its *callee* being cancelled and
then journals state and returns success. That is caller-side handling of
a failed call — an ordinary catchable failure in Effect — not
swallowing of self-cancellation, so the root-interrupt mapping passes
this test shape. The remaining audit item is
`VirtualObjectCommandInterpreter`'s cancellation-related commands,
to be checked during the port.

## 11. Open questions

1. ~~**Effect major**~~ — **decided: effect 4.x.** Consequences: the
   design targets `forkChild`/`callback` naming, v4's
   `Scheduler`/`SchedulerDispatcher` shape, and the v4 Schema API (which
   makes overeng's serde a near-verbatim port). Remaining sub-question is
   release timing against 4.0 final, handled by §9's pre-release policy.
2. **`run` typed-failure transport** (journaled Schema-encoded `Exit`):
   defer to v1.1 (overeng reached the same conclusion), or include
   behind an explicit `error` schema from day one?
3. **Ingress client** (`clients.connect` Effect wrapper with typed error
   decode): v1 or fast-follow?
4. **Journal-cost optimization** for wide fan-outs (batched delivery /
   settled-set journaling): defer until benchmarks say otherwise.
5. ~~**Scheduler API confidence**~~ — **closed.** Everything in §8.1 is
   verified against 4.0.0-rc.112, and the runtime is implemented and
   green: 15 unit tests including a replay-equivalence fuzzer, and 20 e2e
   tests against a real Restate in both `default` and `alwaysReplay`
   modes. The one spike left open is S8-7 (Effect 4's own
   `unstable/workflow` + `unstable/cluster`), which is a positioning
   question, not a risk.
6. **Cooperative cancellation opt-in** (§8.1): default is cancellation →
   root interrupt. Ship a `Restate.cancellation` signal + per-handler
   "cooperative" mode in v1 to preserve gen's catch-and-continue
   capability, or defer until asked for?

# restate-sdk-effect — work breakdown

Target: `@restatedev/restate-sdk-effect`, deep Effect integration per
[DESIGN.md](./DESIGN.md). **Effect major: 4.x** (`4.0.0-rc.112` at time of
writing — see S0-3 for the RC policy).

Legend: `[ ]` open · `[~]` in progress · `[x]` done · **⇢ Sn** depends on
stream/task · **⚡** can start immediately, no dependency · **👤** requires the
user to run an interactive command (agents must not run these).

---

## Parallelism map

| Stream | Scope | Starts after | Runs parallel with |
|---|---|---|---|
| **S0** Scaffolding | package skeleton, deps, CI hooks | now ⚡ | S4·S8·S6 |
| **S1** Runtime core | scheduler, multiplexer, cancellation | S0-1 (+ S8-1/2 answers) | S3·S5(early)·S4·S6 |
| **S2** Authoring surface | service/object/workflow, `Restate.*`, endpoint | S0-1, S1 seam types | S3·S4·S6 |
| **S3** Serde + error boundary | Schema ↔ Serde, terminal/defect policy | S0-1 | S1·S2·S4 |
| **S4** Determinism & unit tests | fake-lib harness, replay fuzzing, type tests | S1 seam interface (contract only) | S1·S2·S3 |
| **S5** Conformance test-services | 16 services, Dockerfile, CI, `--effect` | S2 minimal (service+object+run+state) | S4·S6·S7 |
| **S6** Docs | README, guide, DESIGN upkeep, comparison | now ⚡ | all |
| **S7** Examples + benchmarks | examples pkg, journal-cost bench | S2 | S5·S6 |
| **S8** Spikes | open v4 runtime questions | now ⚡ | all |

Critical path: **S0-1 → S8-1/2 → S1 → S2 → S5 → release**. Everything else
hangs off it and can proceed concurrently.

## Status

**M1–M4 are done; M5 (release) is the only milestone left.** The package
builds, lints, typechecks, and passes API Extractor, ATTW and the repo's
formatter. Green on:

- **47 unit tests** — driver semantics, the replay-equivalence fuzzer (4 program
  shapes × 8 seeds, the claim the package exists for), the unjournaled-async
  detector, the journal cost model, journal entry creation order, interruption
  teardown, the application-runtime lifecycle, contract enforcement, and
  type-level capability tests;
- **55 e2e tests** against a real Restate container: the handler surface and the
  conformance service set, each run twice (`default` and `alwaysReplay`, the
  latter replaying the journal at every step), plus cancellation;
- **267 official conformance tests, 0 exclusions** — all seven suites of
  `sdk-tests.jar` v2.2 (2026-09-02, `restate:main` digest `625e77fa`).

Left for a human:

- **S6-6** — `pnpm changeset` (interactive), when this is ready to release.

## External review, 2026-09-02

Reviewed by `codex@effect-restate-review`. Findings and resolutions:

- [x] `handlerRequest` read the throwing `key` getter on service contexts —
      `RestateInvocation.kind` now gates it (`e2e/handlers.e2e.test.ts`).
- [x] `Proxy/manyCalls` created call entries out of order because a held call
      effect never ran — `Effect.all` starts children in array order
      (`test/entry-order.test.ts`).
- [x] A race-loser `Restate.run` did not abort its closure: `park` now takes an
      interruption hook and `run` aborts its own `AbortSignal`
      (`test/interrupt-teardown.test.ts`, plus the reviewer's `alwaysReplay`
      regression in `e2e/handlers.e2e.test.ts`).
- [x] `explicitCancellation` was accepted but never honored — removed from the
      option types and rejected at definition time. Supporting it is the
      cooperative-cancellation feature in DESIGN §8, not a fix.
- [x] `implement` did not constrain implementations to the descriptor —
      `ImplementationOf<D>` (`test/contracts.test.ts`).
- [x] A void-input client call bound options as the request body — client
      signatures are positional now, so `ping(opts)` is a compile error
      (`test/contracts.test.ts`, wire behaviour in `e2e/handlers.e2e.test.ts`).
- [x] `WorkflowPromise.peek` advertised `null`; the SDK returns `undefined`.
- [x] The application layer was built once per definition — the endpoint now
      owns one runtime and definitions share it (`test/app-runtime.test.ts`).
- [x] `isCancellation`/`isTimeout` only used `instanceof`, missing terminal
      errors reconstructed from the wire — they check the code first.
- [x] Guarantee language was stronger than the implementation: the detector is
      best-effort, not complete, and `Effect.timed` and friends read the clock
      unsafely. Corrected in DESIGN §5, `runtime.ts`, README rule 1, and
      SHARP-EDGES, which now lists the supported time-sensitive surface.
- [ ] **Detector hardening** — deferred by agreement. The two known holes (a raw
      `Promise` continuation landing during a drain, and `forkDetach`) are
      rule-1 violations, so determinism is unaffected; what is missing is the
      diagnostic. Tracked here rather than gating the release.
- [ ] **Runtime input arity in `restate-sdk-core`** — deferred. Contract
      descriptors carry no runtime arity (`iface.json<void, X>()` is types
      only), so a client cannot ask whether a handler takes input. Worth its own
      cross-package proposal; the positional rule above does not need it.

---

## S0 — Scaffolding ⚡

- [x] **S0-1 👤 Create the package.** Ask the user to run `pnpm new` and select:
      type `lib`, name `restate-sdk-effect`, private `no`. Then agent-side:
      fill `package.json` (field order per CLAUDE.md), `tsdown.config.ts`,
      `tsconfig{,.build}.json`, `api-extractor.json`, copyright headers, and run
      `pnpm generate:configs`.
      *(If templates drift, hand-create from `.templates/*.hbs` mirroring
      `packages/libs/restate-sdk-gen`.)*
- [x] **S0-2 Dependency wiring.** `peerDependencies`: `effect` (4.x),
      `@restatedev/restate-sdk`. `dependencies`:
      `@restatedev/restate-sdk-core`. `devDependencies`: pinned `effect` RC.
      tsdown `external`: `effect`, `@restatedev/restate-sdk`, workspace deps.
      Add `effect` to the pnpm catalog if other packages will share it.
- [x] **S0-3 RC policy decision (write it down).** Effect 4 is pre-release:
      pin an exact RC in dev/tests, express the peer range conservatively
      (`>=4.0.0-rc.112 <5`), and gate the first non-`0.x` release on 4.0 final.
      Note the internal seams we depend on (S8) and add a CI job that installs
      the newest 4.x RC nightly so churn surfaces early.
- [x] **S0-4 `pnpm verify` clean** on the empty skeleton before any feature work.

## S1 — Runtime core (critical path) ⇢ S0-1

The three pieces of DESIGN §3. Keep each in its own module; keep every
version-coupled Effect internal behind `src/internal/effect4/` so an Effect
5 / RC-churn port is contained.

- [x] **S1-1 Deterministic scheduler.** Implement v4's `Scheduler`
      (`executionMode: "sync"`, `shouldYield: () => false`,
      `makeDispatcher()` returning **one shared dispatcher per invocation** —
      v4 creates a dispatcher per fiber lazily, so the singleton is what gives
      the invocation a single global FIFO queue). Install via
      `Context.make(Scheduler.Scheduler, ours)` on the invocation runtime
      (verified working) with `RunOptions.scheduler` as fallback.
- [x] **S1-2 Drain to quiescence.** Sync `flush()` over priority buckets plus a
      bounded microtask-turn loop (v4's concurrency combinators need a
      microtask turn between flushes — verified). Non-convergence must fail
      loudly, never spin.
- [x] **S1-3 Source registry + multiplexer loop.** Durable ops register their
      `RestatePromise` synchronously at the call site; park the fiber on an
      in-memory notification; loop: drain → collect pending sources → 1 source:
      await directly (no combinator entry) / N: `RestatePromise.race(tagged)` →
      deliver the journaled winner → drain. Deadlock diagnostic when the set is
      empty and the handler is unfinished.
- [x] **S1-4 Abstract lib seam** (gen's `AwaitableLib` equivalent: `race`,
      `isCancellation`, `isSuspension`, `now`, `rand`) so S4 can test the loop
      with hand-driven deferreds and zero Restate. **Publish these types first**
      — S4 starts from them.
- [x] **S1-5 Settlement classification** (DESIGN §3.4): value / terminal
      rejection / aggregate `CancelledError` → root interrupt / suspension →
      halt + rethrow verbatim with **no finalizers** / `attemptCompletedSignal`.
- [x] **S1-6 Cancellation → root interrupt.** `fiber.interruptUnsafe()`.
      **v4 delta:** interrupt delivery re-enters the fiber *synchronously* at
      our call site (it does **not** go through the dispatcher as in v3), so
      finalizers start inside the `interruptUnsafe()` call; keep driving the
      loop until the root fiber's observer fires, because finalizers may park on
      new journal sources (interrupt-then-join).
- [x] **S1-7 Per-invocation runtime layer.** Journaled `Clock`
      (`currentTimeMillis*` via `ctx.date`, frozen per-attempt sync base,
      `sleep → ctx.sleep`), `Random` via `ctx.rand`, `Logger → ctx.console`
      (logfmt format, replay-suppressed sink), `RestateContext` + capability
      tags. Verified: overriding `Clock.Clock` intercepts **both**
      `Effect.sleep` and `Effect.timeout` — DESIGN §4's remap is real.
- [x] **S1-8 App-layer runtime.** One `ManagedRuntime` per process from the
      user's `Layer`; per-invocation overrides composed on top; `Restate.run`
      closures execute against the **app** runtime (real clock/scheduler) and
      only their journaled result re-enters the deterministic world.
- [x] **S1-9 Unjournaled-op detector.** Primary check (complete for the failure
      mode that matters): **a journal op created while the multiplexer is parked
      outside a drain** — we own every journal call site, so this is a hard
      error with a pointed message ("unjournaled async detected — wrap it in
      Restate.run"). Supplementary signals: dispatcher task enqueued while
      parked, root-fiber exit while parked. Note `Fiber.currentOpCount` is
      **not** monotonic in v4 (resets per slice) — do not build the primary
      check on it.
- [x] **S1-10 Interrupt/abort plumbing.** Per-`run` `AbortSignal` children of
      the attempt signal; deregister sources on fiber interrupt via
      `Effect.callback`'s canceler (verified to run).

## S2 — Authoring surface ⇢ S0-1, S1-4

- [x] **S2-1 Handler shape + factories**: `service` / `object` / `workflow`,
      `handler` / `sharedHandler` with `{ input, output, error }` Schemas,
      producing `Implemented*Definition` from `restate-sdk-core` so Effect
      services interop with gen and promise-SDK clients.
- [x] **S2-2 `iface` + `implement` parity** with gen (shared `ServiceDescriptor`
      contracts).
- [x] **S2-3 `Restate.*` surface**: `run`, `runExit`, `awakeable`,
      `resolve/rejectAwakeable`, `state`/`sharedState`, `key`, `client`/
      `sendClient`, `workflowPromise`, `handlerRequest`, `cancel`, `attach`,
      `invocationSignal`. **No** `sleep`/`timeout`/`race`/`all` — plain Effect
      combinators are the durable ones.
- [x] **S2-4 Capability markers in `R`** (`StateRead`, `StateWrite`,
      `DurablePromise`, `ObjectKey`) + `run` scrubbing them from the inner `R`.
- [x] **S2-5 Endpoint**: `serve({ services, layer })`, discovery, identity keys,
      graceful shutdown, `ManagedRuntime` lifecycle.
- [x] **S2-6 v4 API naming sweep**: v4 has **no `Effect.fork`** — it is
      `forkChild` / `forkIn` / `forkScoped` / `forkDetach`; `Effect.async` is
      `Effect.callback`. Docs, examples and tests must use v4 names.

## S3 — Serde + error boundary ⇢ S0-1

- [x] **S3-1 `effect/Schema` ↔ `restate.Serde`** bridge (port
      `@overeng/restate-effect`'s `Serde.ts` — it already targets the v4 Schema
      API, so this is close to verbatim): sync encode/decode, `contentType`,
      JSON-schema derivation for discovery, empty-body/void handling.
- [x] **S3-2 Slot-aware decode classification**: `ingress` failure →
      `TerminalError(400)`; `internal` failure (state, run result, awakeable) →
      defect/retry.
- [x] **S3-3 Typed error boundary**: declared domain `E` → `TerminalError` with
      Schema-encoded body + `_tag` + per-error `errorCode`; undeclared failure →
      defect; interruption → `CancelledError`; awakeable/durable-promise
      rejections verbatim.
- [x] **S3-4 Client-side decode** of typed errors back into tagged errors for
      `Effect.catchTag`.
- [x] **S3-5 Decide `run` typed-failure transport** (journaled encoded `Exit`)
      — DESIGN open question 2. Default: defer to 1.1, `runExit` covers sagas.

## S4 — Determinism & unit tests ⇢ S1-4 (contract only, start early)

- [x] **S4-1 Fake-lib harness**: hand-controlled deferreds implementing the S1-4
      seam; drive completions in arbitrary orders; assert delivery order.
- [x] **S4-2 Replay-equivalence property test**: record the journal-op creation
      sequence under a random completion order O₁; replay serving completions in
      recorded order; assert byte-identical creation sequence. Fuzz across
      seeds and across `forkChild`/`race`/`timeout`/`forEach(concurrency)`/
      `Queue`/`Semaphore`/`retry(Schedule)` shapes.
- [x] **S4-3 Detector tests**: raw `Effect.promise`, `setTimeout`-driven
      `Effect.callback`, and a rogue library sleep must all fail loudly (S1-9).
- [x] **S4-4 Interruption suite**: cancellation mid-`run`, mid-`sleep`,
      inside `uninterruptible`, in a finalizer that journals, race-loser
      teardown, daemon interrupt-then-join at invocation end.
- [x] **S4-5 Suspension suite**: suspension must **not** run finalizers, must
      rethrow verbatim, and must not leave a partially-journaled tick.
- [x] **S4-6 Type-level tests** for capability markers and `run` scrubbing
      (model: overeng's `capability-inference.types.ts`).
- [x] **S4-7 Package e2e** (testcontainers, mirroring gen's `e2e/`):
      concurrency, saga, terminal errors, transient errors, cancellation,
      suspend/resume mid-`Effect.sleep`, durable retry resumed mid-backoff.
      *Local runs need unsandboxed Docker.*

## S5 — Conformance test-services ⇢ S2 minimal (DESIGN §10.1)

Order matters: simple services first as an endpoint smoke test, interpreters
last. Keep `exclusions.yaml` non-empty while porting; empty is the release gate.

- [x] **S5-1 `test-services/src/server.ts`** — harness env contract: `SERVICES`
      name filter, `PORT` (9080), `E2E_REQUEST_SIGNING` → `identityKeys`.
- [x] **S5-2 `test-services/Dockerfile`** — workspace-root context,
      `pnpm install --frozen-lockfile`, `tini`, launch with `node --import tsx`
      (**not** pnpm: the corepack shim phones home at container start and a
      fetch failure kills the endpoint before it binds).
- [x] **S5-3 Tier 1 services**: `Counter`, `Proxy`, `Failing`, `ListObject`,
      `MapObject`, `AwakeableHolder`, `TestUtilsService`.
- [x] **S5-4 Tier 2**: `NonDeterministic` (must still surface journal-mismatch
      detection through our runtime), `BlockAndWaitWorkflow`,
      `KillTestRunner`/`KillTestSingleton`.
- [x] **S5-5 Tier 3 cancellation**: `CancelTestRunner`/`CancelTestBlockingService`.
      Audit note: the runner catches its *callee's* `TerminalError(409)` — an
      ordinary catchable failure in Effect — so the root-interrupt mapping is
      compatible. **Open audit:** `VirtualObjectCommandInterpreter`'s
      cancellation commands (do this before writing S5-6).
- [x] **S5-6 Tier 4 interpreters**: `VirtualObjectCommandInterpreter`, then
      `ObjectInterpreterL0/L1/L2` + `ServiceInterpreterHelper` — the fuzzer over
      journal ops and concurrency, and the highest-value test for this package.
- [x] **S5-7 `exclusions.yaml` + `.env`**, driven to empty.
- [x] **S5-8 `.tools/run-sdk-tests.sh --effect`** flag (image tag + Dockerfile
      path, next to `--gen`).
- [x] **S5-9 `.github/workflows/integration-effect.yaml`** — clone of
      `integration-gen.yaml`: PR + 6-hour cron + `workflow_call`
      (`restateCommit`/`restateImage`/`serviceImage`) so the runtime repo can
      exercise this SDK.
- [x] **S5-10 Green on all six suites** — 267 passed, 0 failed, no exclusions:
      `default` (55), `alwaysSuspending` (52, the standing replay-torture test
      for §2–3), `singleThreadSinglePartition` (54), `threeNodes` (52),
      `threeNodesAlwaysSuspending` (46), `lazyState` (3),
      `lazyStateAlwaysSuspending` (3), `persistedTimers` (2). Run locally with
      `.tools/run-sdk-tests.sh --effect`; the suite writes its own
      `exclusions.new.yaml`, which came out `exclusions: {}`.
      *Found two bugs no in-house test had: `handlerRequest` read the throwing
      `key` getter on service contexts (`Ingress.headersPassThrough`), and
      `Proxy/manyCalls` held call effects unrun so their journal entries were
      created after a later send's (`CallOrdering`). Both now have regression
      tests — `e2e/handlers.e2e.test.ts` and `test/entry-order.test.ts`.*

## S6 — Docs ⚡

- [x] **S6-1 DESIGN.md → Effect 4** (in flight): peer dep, v4 scheduler/
      dispatcher shape, `forkChild`/`callback` naming, verified-behaviour table
      re-run against 4.0.0-rc.112, detector claim restated (S1-9), open
      question 1 closed.
- [x] **S6-2 README.md** — quickstart, the three user rules, what is durable
      (`sleep`/`timeout`/`retry`/`race`/`forkChild`), what needs `Restate.run`.
- [x] **S6-3 guide.md** — mirroring gen's guide: authoring, state, awakeables,
      RPC, sagas, cancellation semantics, testing.
- [x] **S6-4 Comparison page** — vs `restate-sdk-gen`, vs the promise SDK, vs a
      thin Effect binding (what deep integration buys, what it costs).
- [x] **S6-5 Sharp edges doc** — swallowable cancellation gap, daemon
      interrupt-then-join at invocation end, journal cost of wide fan-out,
      uninterruptible + suspension interaction.
- [ ] **S6-6 👤 Changeset** — ask the user to run `pnpm changeset` before release.

## S7 — Examples + benchmarks ⇢ S2

- [x] **S7-1 Examples package** — greeter, a saga with compensations, a durable
      fan-out, a long `Effect.sleep` workflow, `Effect.retry` with durable
      backoff.
- [x] **S7-2 Journal-cost benchmark** — entries/op for sequential vs
      N-way-concurrent programs; compare with gen and the promise SDK. Feeds
      DESIGN open question 4 (batched delivery).
- [x] **S7-3 Throughput sanity** — scheduler overhead per journal op.

## S8 — Spikes (answer before/while S1 lands) ⚡

Findings go into DESIGN.md; each spike is a throwaway script run outside
the repo (the scheduler/interruption, detector and typecheck-smoke labs
behind DESIGN §8.1 were run this way and are not checked in).

- [x] **S8-1 `onFiberStart` coverage** — does `RunOptions.onFiberStart` fire for
      every descendant fiber, or only the root? Decides whether we can maintain
      a complete fiber registry (useful for diagnostics and for S1-9's
      supplementary signals).
- [x] **S8-2 Dispatcher capture by data structures** — `Queue` captures
      `fiber.currentDispatcher` (`Queue.ts:456`), and `Semaphore`/`Pool`/
      `Schema` schedule or `flush()` on it. Verify the shared-dispatcher
      singleton makes all of these behave, including a `Queue` created in one
      fiber and consumed in another after an interrupt.
- [x] **S8-3 Interrupt-then-join under journaling finalizers** — a finalizer
      that awaits a durable op during root interrupt must complete before we
      report the outcome; prove the loop drives it and cannot deadlock.
- [x] **S8-4 `Effect.timeout` over a durable op** — with `Clock.sleep → ctx.sleep`,
      confirm the losing branch (the timer or the op) is torn down cleanly and
      the journal shape is replay-stable.
- [x] **S8-5 ManagedRuntime + per-invocation overrides** — cheapest correct way
      to compose invocation-scoped `Clock`/`Random`/`Logger`/`Scheduler` over a
      process-wide app runtime without rebuilding layers per invocation.
- [x] **S8-6 `PreventSchedulerYield` / `MaxOpsBeforeYield`** — belt-and-braces
      against involuntary op-budget yields; decide whether to set them.
- [x] **S8-7 Effect 4 `unstable/workflow` + `unstable/cluster`** — Effect ships
      its own durable-execution modules. Read them, decide: ignore, interop, or
      implement their interfaces on Restate (positioning question for S6-4).
- [x] **S8-8 Structured-concurrency defaults in v4** — `forkChild` vs
      `forkScoped` vs `forkDetach` lifetimes at invocation end; confirm DESIGN
      §8's end-of-invocation contract against v4 semantics.

---

## Milestones

- **M1 walking skeleton** — S0 + S1-1…S1-4 + a `service` with one handler doing
  `Restate.run`, running against a local Restate. Proves the loop.
- **M2 concurrency proof** — S1 complete + S4-1…S4-5 green, including the
  replay-equivalence fuzzer over `forkChild`/`race`/`timeout`.
- **M3 conformance** — S5 green on `default` + `alwaysSuspending`, exclusions
  documented.
- **M4 full conformance + docs** — S5-10 with empty exclusions, S6, S7-1. Done.
- **M5 release** — pinned to Effect 4.0 final, changeset, publish.

## Risk register

| Risk | Mitigation |
|---|---|
| Effect 4 RC churn breaks the runtime seams | all internals behind one module; nightly newest-RC CI job (S0-3); pin exact RC in dev |
| A journal op created outside our drain corrupts the journal silently | S1-9 hard detector + S4-3 tests; `alwaysSuspending` conformance suite as the black-box net |
| Interrupt-driven finalizers deadlock the loop | S8-3 spike before S1-6 is called done |
| Journal cost of wide fan-out surprises users | S7-2 benchmark, documented cost model (DESIGN §3.5), batched delivery deferred |
| Cancellation semantics differ from gen (not swallowable) | documented (S6-5); optional cooperative mode is DESIGN open question 6 |
| Conformance interpreters expose gaps late | port them last but audit their command set early (S5-5) |

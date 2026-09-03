# restate-sdk-effect — API revision (pre-v1)

The build-out breakdown that produced the package is in git history at
`bed62a9`; this file replaces it with the work from
`codex@effect-restate-review`'s API review of 2026-09-02 (channel
`#restate-effect-sdk-review-2026-09-02`).

The core model is settled and not in scope: `handler` +
`service`/`object`/`workflow`, `implement`, `run`, ordinary Effect
combinators, typed clients, state, `serve`. No Restate-specific
`sleep`/`race`/`all` operators. What changes is the surrounding surface —
duplicated declarations, ambiguous client arguments, and autocomplete
noise — while nothing is published and it is still free.

Legend: `[ ]` open · `[~]` in progress · `[x]` done · **👤** needs a human.

Order matters: **A → B → C → E → D**. D (export grouping) is mechanical
and touches every file, so it goes last, after the surface has stopped
moving.

---

## A — Branded client options ⇢ none

`Client`/`SendClient` methods take plain `CallOptions`/`SendOptions`
objects, which cannot be told from a request body. The current fix is a
positional rule (`ping(undefined, opts)`); the promise SDK already solved
this properly with separately branded wrappers, and matching it means one
mental model across all three SDKs.

- [x] **A-1** Retype `Client<H>` to `(opts?: restate.Opts<I, O>)` for void
      input and `(input: I, opts?: restate.Opts<I, O>)` otherwise;
      `SendClient<H>` likewise with `restate.SendOpts<I>`.
- [x] **A-2** Discriminate in `splitArgs` by brand: a lone argument that is
      an `Opts`/`SendOpts` instance is options, anything else is input. No
      shape heuristics — a body can look exactly like options.
- [x] **A-3** Read the wrapped options out. `Opts` holds them in a private
      field behind a private constructor, so this needs one cast, in one
      helper, commented.
- [x] **A-4** Re-export `rpc.opts` / `rpc.sendOpts` (under `rpc`, see D-1) so
      users need no second import; drop the now-unused `CallOptions` /
      `SendOptions` from the client types. `CallRequest`/`SendRequest` keep
      their inline options — those are by-name calls, not client methods.
- [x] **A-5** Retire the positional rule: replace the `ping(undefined, opts)`
      assertions in `test/contracts.test.ts` with brand-based ones, keeping a
      `@ts-expect-error` proving an unbranded object is still rejected.
- [x] **A-6** Update the e2e wire probe (`clientRules`) and the docs/tutorial
      call sites.

## B — Bare Effect functions in `implement` ⇢ A

A descriptor already owns each handler's codecs and shared marker, so
`implement(C, { greet: handler({}, fn) })` restates the contract, and
`sharedHandler` restates its shared marker. Worse, the `ImplementationOf`
constraint currently _rejects_ implementing an `iface.shared` slot with
plain `handler` — friction introduced by the constraint itself.

- [x] **B-1** Accept a bare `(input: I) => Effect<O, E, R>` for any slot in
      `ImplementationOf<D>`, alongside the existing `Handler` form.
- [x] **B-2** Wrap bare functions at runtime using the descriptor's codecs
      and shared marker.
- [x] **B-3** Compute requirements (`HandlersRequire`) from either form —
      a bare function's `R` comes from its returned effect.
- [x] **B-4** Take sharedness from the contract, so an explicit `handler(...)`
      in a shared slot is accepted rather than rejected.
- [x] **B-5** `handler(...)` stays available for handler-local discovery
      options and declared domain-error codecs; test both forms in one
      `implement` call.

## C — Tighter definition-site typing ⇢ B

A compile-only probe confirms all three of these compile today, and each
is a bug the type system should have caught.

- [x] **C-1** A handler whose effect can fail (`E` ≠ `never`) with no
      `error:` codec must not compile. Today it type-checks and the failure
      is silently treated as a defect and retried — SHARP-EDGES documents it
      as a sharp edge; it should be a compile error instead.
- [x] **C-2** `sharedHandler` inside a plain `service` must not compile —
      services have no shared/exclusive distinction.
- [x] **C-3** `sharedHandler` as a workflow's `run` must not compile — the
      `run` handler is exclusive by definition.
- [x] **C-4** Type-level tests for all three, plus the accepted placements
      (shared handlers in objects, shared non-`run` workflow handlers).
- [x] **C-5** Fix whatever C-1 breaks in this package's own handlers
      (`Effect.orDie` where a defect is genuinely intended, an `error:` codec
      where it is not).

## D — Group the root exports ⇢ A, B, C, E

~115 names at the root, many exported only so API Extractor can trace a
public signature. Users see all of it in autocomplete. **Result: 75, of which
~31 are values.**

API Extractor will not accept a namespace re-export for traceability — it
wants direct entry-point exports — but tsdown already emits these types as
*non-exported* local declarations in `dist/index.d.ts`, so the shipped
declarations are self-contained without them. `ae-forgotten-export` is
therefore a warning in this package's `api-extractor.json` rather than an
error, so the deliberate internals pass while a genuinely accidental omission
still prints.

- [x] **D-1** `rpc` — `call`, `send`, `detached`, `opts`, `sendOpts`.
- [x] **D-2** `endpoint` — `bind`, `createHandler`, `dispose`. `serve` stays
      at the root.
- [x] **D-3** `unsafe` — `rawContext`, `durable`.
- [x] **D-4** `diagnostics` — `isProcessing`, `abortSignal`.
- [x] **D-5** Stop root-exporting the traceability-only types
      (`AppRuntimeBinding`, `EffectHandlerImpl`, `InvocationDriver`,
      `Awaitable`, `HandlerKind`, the capability-calculation helpers, marker
      values, and the bulk re-export of core SDK types). API Extractor still
      needs them reachable, so they move under a namespace rather than
      disappearing.
- [x] **D-6** Keep at the root what authors use constantly: `handler`,
      `sharedHandler`, `service`, `object`, `workflow`, `implement`, `serve`,
      `run`, `state`, `client`, `sendClient`, `scope`, `invocation`, the
      awakeable/signal/promise operations, `handlerRequest`, `key`, `uuid`,
      `terminalError`, the error types and classifiers, `schemaSerde`,
      `iface`, `serde`, and the capability services.
- [x] **D-7** Re-run the export count and record it; update every doc,
      example and test call site the regrouping moves.

## E — Pre-release polish ⇢ A

- [x] **E-1** Remove `runExit`. It is `Effect.exit(run(...))` and, because
      `run`'s closure cannot have a typed error channel, it captures nothing
      extra. Update the saga example, the tutorial and the e2e test.
- [x] **E-2** Schema-bound state cells, so a key's codec is declared once —
      `const count = state("count", Schema.Number)`, then `count.get`,
      `count.set(v)`, `count.clear`. `state` becomes callable while keeping
      `state.get/set/clear/keys/clearAll` for the ad-hoc form.
- [x] **E-3** `iface.schema({ input, output })` and `iface.shared.schema(...)`
      in this package's `iface`, so an Effect user writes Schemas rather than
      `iface.serdes({ input: schemaSerde(...) })`. Wraps core's `iface`.
- [x] **E-4** Add pipeable `activity(name, { result, error, retry })` as the
      preferred external-effect boundary. Journal typed failures as data for
      Effect-owned domain retry; leave defects to Restate's technical retry.

## Verification gate

Every item lands with tests; these all pass before the work is called done.

- [x] **V-1** 76 unit tests green (`pnpm _test`).
- [x] **V-2** 55 e2e tests green against a real container
      (`vitest run --config vitest.e2e.config.ts`).
- [x] **V-3** `turbo run lint _check:types _build _check:exports _check:api
  _test check:format --filter="./packages/libs/*"` — 57/57.
- [x] **V-4** 267 official conformance tests, 0 exclusions
      (`.tools/run-sdk-tests.sh --effect`, needs Java + Docker).
- [x] **V-5** Docs consistent with the final surface: README (new Clients and
      Contracts sections, the namespaces, the error rule), guide, SHARP-EDGES,
      DESIGN §6, tutorial. Note `*.md` is in `.prettierignore` — do not run
      prettier over these files; it rewrites emphasis markers and tables and
      buries the real diff.
- [x] **V-6** Posted to the review channel for re-probing (message 120).

## Left for a human

- [ ] **👤 S6-6** `pnpm changeset` before release (interactive).

## Note for whoever reviews this branch

`flake.nix` and `flake.lock` are in the API-revision commit (`fcc63d6`) by
accident: they were already staged, and the commit was made without a
pathspec. They belong to the nix dev shell, not to this work. Left in place
deliberately rather than rewriting a pushed branch.

## Deferred by agreement

- **Detector hardening.** The unjournaled-async check is best-effort: a raw
  `Promise` continuation landing during a drain, and a `forkDetach` fiber
  outliving the invocation, both escape it. Each is a rule-1 violation, so
  determinism is unaffected — what is missing is the diagnostic. DESIGN §5
  now says so plainly.
- **Runtime input arity in `restate-sdk-core`.** Contract descriptors carry
  no runtime arity (`iface.json<void, X>()` is types only). Worth a
  cross-package proposal of its own; A's brand-based discrimination does not
  need it.

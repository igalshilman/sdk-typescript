# restate-sdk-effect — guide

This guide covers authoring services with `@restatedev/restate-sdk-effect`. For
*why* ordinary Effect concurrency is safe here, read
[DESIGN.md](./DESIGN.md); for the traps, [SHARP-EDGES.md](./SHARP-EDGES.md).

Everything below assumes:

```ts
import { Effect, Schedule, Schema } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";
```

## 1. Handlers

A handler is `(input) => Effect<Output, DomainError, R>`, wrapped in
`restate.handler` together with its codecs:

```ts
const greeter = restate.service({
  name: "greeter",
  handlers: {
    greet: restate.handler(
      { input: Schema.String, output: Schema.String },
      (name) => Effect.succeed(`Hello ${name}`)
    ),
  },
});
```

Codecs are optional; without them the input and output are plain JSON. With
them you get validation at the boundary and a JSON Schema in service discovery.
A codec is either an Effect `Schema` or a `restate.Serde`.

Handler options:

| Option | Meaning |
|---|---|
| `input`, `output` | codecs for the request and response bodies |
| `error` | codec for the handler's declared domain errors (§6) |
| `errorCode` | terminal error code for those failures (default 500) |
| `description`, `metadata` | surfaced in discovery |
| `enableLazyState` | opt into lazy state (Restate 1.4+) |

## 2. External activities

Pipe an external Effect through `restate.activity(name, options)` to record its
outcome in the journal. On replay, the Effect is not re-executed — its recorded
outcome is served instead:

```ts
const id = yield* Effect.sync(() => crypto.randomUUID()).pipe(
  restate.activity("gen-id", { result: Schema.String })
);
const user = yield* fetchUser(id).pipe(
  restate.activity("fetch-user", { result: User, error: FetchUserError })
);
```

Successes and declared typed failures are both journaled. The typed failure is
then restored to Effect's error channel, so Effect owns domain policy. Defects
are not encoded: they reject the underlying Restate run, so Restate owns its
technical retry policy. If Restate gives up, the activity fails with
`RestateFailure` in addition to its declared error:

```ts
const charged = yield* charge(order).pipe(
  restate.activity("charge", { result: Receipt, error: PaymentDeclined }),
  Effect.retry({
    schedule: Schedule.exponential("1 second"),
    times: 4,
    while: (error) => error instanceof PaymentDeclined,
  })
);
```

Filtering the retry matters: an unfiltered `Effect.retry` would also retry a
`RestateFailure` after Restate had exhausted the technical policy. Every retry
of `PaymentDeclined` above is a fresh journaled activity; every schedule delay
is a durable timer.

The wrapped Effect runs on your **application** runtime — the real clock, real
scheduler and real I/O — and receives cancellation through Restate's abort
plumbing. Journal operations are unavailable inside it, and using one is a
compile error. Keep an activity to one independently committable external
operation; wrapping a large workflow would make all of it repeat after a
technical failure.

Restate-owned defect retries are configured on the activity:

```ts
yield* charge(order).pipe(
  restate.activity("charge", {
    result: Receipt,
    error: PaymentDeclined,
    retry: { maxAttempts: 5, initialInterval: 200, maxInterval: 5_000 },
  })
);
```

`restate.run(name, effect, options)` remains as the lower-level form for an
already-infallible `Effect<A, never, R>`. Most application code should use
`activity`.

## 3. Time, randomness, logging

These are ambient Effect services, journaled by this SDK:

```ts
const now = yield* Clock.currentTimeMillis;   // journaled read
const dice = yield* Random.nextIntBetween(1, 7);
yield* Effect.logInfo("charging", { order: order.id });
yield* Effect.sleep("30 minutes");            // durable timer
```

`Effect.sleep` suspends the invocation: the process may exit, and Restate
re-invokes the handler when the timer fires. That also makes
`Effect.timeout` a durable timeout and `Effect.retry(schedule)` a durable
backoff.

`Date.now()` and `Math.random()` are *not* journaled and will diverge on
replay. `restate.uuid` gives you a deterministic UUID v4.

## 4. Concurrency

Ordinary Effect concurrency, over durable operations:

```ts
// parallel durable steps
const [user, stock] = yield* Effect.all(
  [
    fetchUser(id).pipe(restate.activity("user")),
    checkStock(items).pipe(restate.activity("stock")),
  ],
  { concurrency: "unbounded" }
);

// bounded fan-out
yield* Effect.forEach(
  items,
  (it, i) => ship(it).pipe(restate.activity(`ship-${i}`)),
  { concurrency: 5 }
);

// race: the winner is journaled, the loser is interrupted and finalized
const first = yield* Effect.race(
  callPrimary().pipe(restate.activity("primary")),
  Effect.as(Effect.sleep("5 seconds"), "timeout")
);

// background work, with in-memory coordination
const events = yield* Queue.make<string>();
yield* Effect.forkChild(reportProgress(events));
```

Interleaving over durable operations is decided by the journal, not by
wall-clock timing, so all of the above replays identically.

Two rules for fibers:

- `forkChild` and `forkScoped` are fine. They are interrupted when the
  invocation ends, and their finalizers run *inside* the invocation, so
  cleanup can journal.
- `forkDetach` is not supported: a detached fiber outlives the invocation.

## 5. State

Virtual objects and workflows have Schema-typed state:

```ts
const count = yield* restate.state.get("count", Schema.Number); // number | null
yield* restate.state.set("count", Schema.Number, (count ?? 0) + 1);
yield* restate.state.clear("count");
yield* restate.state.clearAll();
const keys = yield* restate.state.keys();
```

Reads need the `StateRead` capability, writes need `StateWrite`. Exclusive
object handlers (`restate.handler`) get both; shared handlers
(`restate.sharedHandler`) only get `StateRead`, so writing state from a shared
handler does not compile.

## 6. Errors

Three outcomes leave a handler, and Restate treats them differently:

| Outcome | Effect | Restate |
|---|---|---|
| declared domain failure | `Effect.fail(new OutOfStock(...))` | `TerminalError` carrying the encoded error; not retried |
| defect | `Effect.die(...)`, a thrown exception | the attempt is retried |
| interruption | cancellation, `Fiber.interrupt` | reported as cancelled; not retried |

Declare the domain errors with `error:`:

```ts
class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  item: Schema.String,
}) {}

order: restate.handler(
  { input: Schema.String, output: Receipt, error: OutOfStock, errorCode: 409 },
  (item) => Effect.gen(function* () { ... })
)
```

A failure the declared codec cannot encode is treated as a defect rather than
mis-encoded, so classification drift shows up as a retry, not as a wrong
terminal error.

Failures that come *from* Restate — a call whose target failed, a `run` whose
retries were exhausted, a rejected awakeable, a durable timeout — arrive as
`restate.RestateFailure`, a tagged error you can catch:

```ts
yield* restate.client(Payments).charge(order).pipe(
  Effect.catchTag("RestateFailure", (failure) =>
    failure.code === 409 ? compensate() : Effect.failCause(Cause.fail(failure))
  )
);
```

## 7. Calling other services

Contracts come from `restate.iface`, so they can live in a package shared by
callers and implementers:

```ts
// contract
export const Greeter = restate.iface.service("greeter", {
  greet: restate.iface.serdes({
    input: restate.schemaSerde(Schema.String),
    output: restate.schemaSerde(Schema.String),
  }),
});

// caller
const greeting = yield* restate.client(Greeter).greet("world");
const handle = yield* restate.sendClient(Greeter).greet("later", {
  delay: 60_000,
});
const id = yield* handle.invocationId;

// keyed targets
const total = yield* restate.client(Cart, cartId).total();

// implementation, in another package
export const greeter = restate.implement(Greeter, {
  greet: restate.handler({}, (name) => Effect.succeed(`Hello ${name}`)),
});
```

`restate.scope("tenant-7").client(...)` routes calls through a cluster scope.

To decode a callee's declared error back into a tagged error, add
`restate.decodeFailure(TheirError)` to the call.

## 8. Awakeables and workflow promises

```ts
// awakeable: completed from outside, by id
const approval = yield* restate.awakeable(Schema.Boolean);
yield* requestApproval(approval.id).pipe(restate.activity("ask-human"));
const approved = yield* approval.result; // suspends until resolved

// from anywhere else
yield* restate.resolveAwakeable(id, Schema.Boolean, true);
yield* restate.rejectAwakeable(id, "denied");

// workflow promise: shared between a workflow's handlers
const paid = yield* restate.workflowPromise("paid", Schema.Boolean);
yield* paid.resolve(true);
const value = yield* paid.result;
```

## 9. Serving

```ts
restate.serve({ services: [greeter, counter], layer: AppLayer, port: 9080 });
```

Other entry points:

- `restate.endpoint.createHandler({ services, layer })` — when you own the HTTP
  server;
- `restate.endpoint.bind({ services, layer })` — returns plain SDK definitions, for an
  endpoint that also serves promise-SDK or `restate-sdk-gen` services;
- `restate.endpoint.dispose(services)` — closes the application layer's scope.

## 10. Testing

Handlers are ordinary Effects, so most logic can be tested without Restate by
providing the services yourself. For behaviour that depends on the journal —
suspension, replay, cancellation — use
[`@restatedev/restate-sdk-testcontainers`](../restate-sdk-testcontainers):

```ts
const env = await RestateTestEnvironment.start({
  services: [greeter],
  alwaysReplay: true, // replay the journal at every step
});
const ingress = connect({ url: env.baseUrl() });
await expect(ingress.client(greeter).greet("world")).resolves.toBe("Hello world");
```

`alwaysReplay` is the mode worth keeping in CI: it forces a suspension between
steps, so any nondeterminism in a handler shows up as a journal mismatch.

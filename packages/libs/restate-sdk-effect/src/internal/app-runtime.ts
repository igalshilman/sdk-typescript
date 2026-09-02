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

// The application runtime slot (DESIGN §3.3, TODO S1-8).
//
// A service definition is built before the endpoint exists, but its handlers
// need the application services. Each definition therefore carries a slot that
// the endpoint fills in with a `ManagedRuntime` built from the user's `Layer`.
// The layer is built once per process — the first invocation awaits it, the rest
// read the memoized context.
//
// A definition whose handlers need no application services works without a slot
// being filled: the fallback is an empty context. That is what lets an Effect
// service be registered with the plain SDK endpoint (`restate.endpoint()`).

import { Context, type Effect, type Layer, ManagedRuntime } from "effect";

export class AppRuntimeSlot {
  private managed: ManagedRuntime.ManagedRuntime<never, unknown> | undefined =
    undefined;
  private cached: Context.Context<never> | undefined = undefined;
  private pending: Promise<Context.Context<never>> | undefined = undefined;
  /** Set when this definition shares another slot's runtime — see `shareWith`. */
  private shared: AppRuntimeSlot | undefined = undefined;

  /**
   * Delegate to another slot instead of owning a runtime.
   *
   * A definition is built before the endpoint exists, so each one starts with
   * its own slot. The endpoint owns the *runtime*: it creates one slot per
   * `bind()` and points every definition at it, so a layer holding a connection
   * pool is built once for the endpoint rather than once per service.
   */
  shareWith(target: { provide: AppRuntimeSlot["provide"] }): void {
    // The endpoint hands us another definition's binding, which is always one
    // of these — the interface is narrowed only to keep the published type free
    // of this class's internals.
    const slot = target as AppRuntimeSlot;
    if (slot === this || this.managed !== undefined) return;
    this.shared = slot;
  }

  /** Bind a layer to this slot. Called by the endpoint, before serving. */
  provide<R, E>(layer: Layer.Layer<R, E, never>): void {
    if (this.shared !== undefined) {
      this.shared.provide(layer);
      return;
    }
    if (this.managed !== undefined) return;
    this.managed = ManagedRuntime.make(
      layer
    ) as unknown as ManagedRuntime.ManagedRuntime<never, unknown>;
  }

  /**
   * The application services. Resolved once, then memoized: after the first
   * invocation this returns an already-settled promise.
   */
  context(): Promise<Context.Context<never>> {
    if (this.shared !== undefined) return this.shared.context();
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    if (this.managed === undefined) {
      this.cached = Context.empty();
      return Promise.resolve(this.cached);
    }
    const managed = this.managed;
    this.pending ??= managed.context().then((context) => {
      this.cached = context;
      return context;
    });
    return this.pending;
  }

  /** Close the application layer's scope. */
  dispose(): Promise<void> {
    // The resources live in the shared runtime, so this forwards. Disposing is
    // idempotent, which is what makes `dispose([a, b, c])` safe when a, b and c
    // share one runtime.
    if (this.shared !== undefined) return this.shared.dispose();
    const managed = this.managed;
    if (managed === undefined) return Promise.resolve();
    this.managed = undefined;
    this.cached = undefined;
    this.pending = undefined;
    return managed.dispose();
  }

  /** Run an effect against the application services (endpoint startup tasks). */
  runPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
    if (this.shared !== undefined) return this.shared.runPromise(effect);
    const managed = this.managed;
    if (managed === undefined) {
      throw new Error(
        "@restatedev/restate-sdk-effect: no application layer is bound to this endpoint"
      );
    }
    return managed.runPromise(effect);
  }
}

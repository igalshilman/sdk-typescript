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

// Contract declaration, with Schemas.
//
// This is `restate-sdk-core`'s `iface` — the same descriptors the promise and
// gen SDKs consume, so an Effect service interoperates with their clients —
// plus `schema(...)`, which takes an Effect `Schema` directly instead of
// `serdes({ input: schemaSerde(...) })`.

import type { Schema } from "effect";
import {
  iface as coreIface,
  type HandlerDescriptor,
  type ServiceInterface,
} from "@restatedev/restate-sdk-core";
import { schemaSerde } from "./serde.js";
import type { AnySchema, SchemaType } from "./serde.js";

/** `schema({ input, output })` — an Effect `Schema` per direction. */
export interface SchemaDeclarators {
  schema<SI extends AnySchema, SO extends AnySchema>(opts: {
    input?: SI;
    output?: SO;
  }): HandlerDescriptor<SchemaType<SI>, SchemaType<SO>, false>;
}

/** The shared (read-only) counterpart. */
export interface SharedSchemaDeclarators {
  schema<SI extends AnySchema, SO extends AnySchema>(opts: {
    input?: SI;
    output?: SO;
  }): HandlerDescriptor<SchemaType<SI>, SchemaType<SO>, true>;
}

/** Core's contract API, plus Schema-based handler declarators. */
export type EffectServiceInterface = ServiceInterface &
  SchemaDeclarators & {
    readonly shared: ServiceInterface["shared"] & SharedSchemaDeclarators;
  };

function schemaDescriptor(
  opts: { input?: AnySchema; output?: AnySchema },
  shared: boolean
): HandlerDescriptor<unknown, unknown, boolean> {
  const serdes = {
    input: opts.input
      ? schemaSerde(opts.input as Schema.Codec<unknown, unknown>)
      : undefined,
    output: opts.output
      ? schemaSerde(opts.output as Schema.Codec<unknown, unknown>)
      : undefined,
  };
  // Through the namespace, so the declarators keep their own `this`.
  const descriptor = shared
    ? coreIface.shared.serdes(serdes)
    : coreIface.serdes(serdes);
  return descriptor as HandlerDescriptor<unknown, unknown, boolean>;
}

/**
 * Declare a service contract: handler names with their codecs, no
 * implementation. Put it in a package both the implementation (via
 * `implement`) and its callers (via `client`) import.
 *
 * ```ts
 * const Greeter = iface.service("greeter", {
 *   greet: iface.schema({ input: Schema.String, output: Schema.String }),
 *   ping: iface.json<void, string>(),
 * });
 * ```
 */
export const iface: EffectServiceInterface = {
  ...coreIface,
  schema: ((opts: { input?: AnySchema; output?: AnySchema }) =>
    schemaDescriptor(opts, false)) as SchemaDeclarators["schema"],
  shared: {
    ...coreIface.shared,
    schema: ((opts: { input?: AnySchema; output?: AnySchema }) =>
      schemaDescriptor(opts, true)) as SharedSchemaDeclarators["schema"],
  },
};

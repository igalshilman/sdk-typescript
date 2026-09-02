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

/* eslint-disable @typescript-eslint/no-explicit-any */

// `effect/Schema` <-> `restate.Serde` (DESIGN §6.3).
// =============================================================================
//
// Everything that crosses the journal — handler input and output, state values,
// `run` results, awakeable payloads, durable promises — is governed by a Schema.
// The bridge is deliberately thin:
//
//   - encode/decode go through the Schema (`encodeSync`/`decodeUnknownSync`),
//     not `JSON.stringify`, so transformations (dates, classes, branded types,
//     `Schema.Class`) round-trip correctly;
//   - the wire format is JSON, and an empty body decodes as `undefined` so
//     `void` handlers and absent state work;
//   - the JSON Schema for discovery is derived from the same Schema.
//
// Slot-aware failure classification (DESIGN §6.3 / TODO S3-2) falls out of where
// the SDK calls us, and needs no logic here: a decode failure on *handler input*
// is turned into `TerminalError(400)` by the SDK (a deterministic bad request),
// while a decode failure on an *internal* slot — state, a `run` result, an
// awakeable payload — propagates as a defect and retries the attempt, which is
// the right answer for a corrupt journal value.

import { Schema } from "effect";
import type * as restate from "@restatedev/restate-sdk";

/** Any Effect Schema usable as a journal codec. */
export type AnySchema = Schema.Codec<any, any>;

/** The decoded (in-memory) type of a Schema. */
export type SchemaType<S> = S extends Schema.Codec<infer T, any> ? T : never;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

/**
 * A `restate.Serde<T>` backed by an Effect Schema.
 *
 * ```ts
 * const serde = schemaSerde(Schema.Struct({ name: Schema.String }));
 * ```
 */
export function schemaSerde<S extends AnySchema>(
  schema: S
): restate.Serde<SchemaType<S>> {
  const decode = Schema.decodeUnknownSync(schema);
  const encode = Schema.encodeSync(schema);
  return {
    contentType: "application/json",
    // A schema that accepts nothing at all (`Schema.Void`, or anything
    // optional) must not advertise a JSON Schema: Restate's ingress would then
    // reject an empty body, since "absent" is not expressible in JSON Schema.
    // Same shape the promise SDK produces for a `void` handler.
    jsonSchema: acceptsEmptyBody(decode, encode)
      ? undefined
      : jsonSchemaOf(schema),
    serialize(value: SchemaType<S>): Uint8Array {
      const encoded: unknown = encode(value);
      if (encoded === undefined) return EMPTY;
      return encoder.encode(JSON.stringify(encoded));
    },
    deserialize(data: Uint8Array): SchemaType<S> {
      const json: unknown =
        data.length === 0 ? undefined : JSON.parse(decoder.decode(data));
      return decode(json) as SchemaType<S>;
    },
  };
}

/** True when an empty body is a valid value for this Schema. */
function acceptsEmptyBody(
  decode: (input: unknown) => unknown,
  encode: (value: never) => unknown
): boolean {
  try {
    return encode(decode(undefined) as never) === undefined;
  } catch {
    return false;
  }
}

/**
 * JSON Schema for discovery, or `undefined` when the Schema has no JSON Schema
 * representation (a recursive or unrepresentable codec). Discovery metadata is
 * best-effort: never fail a service definition over it.
 */
function jsonSchemaOf(schema: AnySchema): object | undefined {
  try {
    const standard = Schema.toStandardJSONSchemaV1(schema);
    // `input` is the *encoded* side — the shape that actually travels on the
    // wire, which is what discovery describes.
    return standard["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Schema *or* an already-built Serde into a Serde. Every public
 * option that accepts a codec accepts both.
 */
export function toSerde<T>(
  codec: Schema.Codec<T, any> | restate.Serde<T> | undefined
): restate.Serde<T> | undefined {
  if (codec === undefined) return undefined;
  if (isSerde(codec)) return codec;
  return schemaSerde(codec);
}

function isSerde<T>(
  codec: Schema.Codec<T, any> | restate.Serde<T>
): codec is restate.Serde<T> {
  return (
    typeof (codec as restate.Serde<T>).serialize === "function" &&
    typeof (codec as restate.Serde<T>).deserialize === "function"
  );
}

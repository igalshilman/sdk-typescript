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

import { Effect } from "effect";
import * as restate from "@restatedev/restate-sdk-effect";

type ProxyRequest = {
  serviceName: string;
  handlerName: string;
  message: number[];
  virtualObjectKey?: string;
  idempotencyKey?: string;
  delayMillis?: number;
  scope?: string;
  limitKey?: string;
};

// Field names are the wire contract of sdk-test-suite's
// `dev.restate.sdktesting.contracts.Proxy$ManyCallRequest` — a typo here reads
// as `undefined` and silently changes which branch runs.
type ManyCallsRequest = {
  proxyRequest: ProxyRequest;
  oneWayCall: boolean;
  awaitAtTheEnd: boolean;
};

const toBytes = (message: number[]): Uint8Array => Uint8Array.from(message);

export const proxy = restate.service({
  name: "Proxy",
  handlers: {
    call: restate.handler({}, (req: ProxyRequest) =>
      Effect.map(
        restate.rpc.call<Uint8Array, Uint8Array>({
          service: req.serviceName,
          method: req.handlerName,
          key: req.virtualObjectKey,
          parameter: toBytes(req.message),
          idempotencyKey: req.idempotencyKey,
          inputSerde: restate.serde.binary,
          outputSerde: restate.serde.binary,
          scope: req.scope,
          limitKey: req.limitKey,
        }),
        (result) => Array.from(result)
      )
    ),

    oneWayCall: restate.handler({}, (req: ProxyRequest) =>
      Effect.gen(function* () {
        const handle = yield* restate.rpc.send<Uint8Array>({
          service: req.serviceName,
          method: req.handlerName,
          key: req.virtualObjectKey,
          parameter: toBytes(req.message),
          idempotencyKey: req.idempotencyKey,
          inputSerde: restate.serde.binary,
          delay: req.delayMillis,
          scope: req.scope,
          limitKey: req.limitKey,
        });
        return yield* handle.invocationId;
      })
    ),

    // Several calls in flight at once. The awaited ones are raced through the
    // Several calls in flight at once.
    //
    // `CallOrdering` asserts the callee observes these in request order, and
    // Restate orders deliveries by *journal entry creation*. Effects are lazy,
    // so a call whose effect is merely stored in a list creates nothing —
    // holding one back to await later would let a later send's entry be created
    // first. `Effect.all` with unbounded concurrency starts the children in
    // array order, which fixes entry order to request order; awaiting the
    // results is what happens "at the end".
    manyCalls: restate.handler({}, (requests: ManyCallsRequest[]) =>
      Effect.all(
        requests.map((req) => {
          const pr = req.proxyRequest;
          const target = {
            service: pr.serviceName,
            method: pr.handlerName,
            key: pr.virtualObjectKey,
            parameter: toBytes(pr.message),
            idempotencyKey: pr.idempotencyKey,
            inputSerde: restate.serde.binary,
            scope: pr.scope,
            limitKey: pr.limitKey,
          };
          if (req.oneWayCall) {
            return Effect.flatMap(
              restate.rpc.send<Uint8Array>({
                ...target,
                delay: pr.delayMillis,
              }),
              // The reference service reads the id here too.
              (handle) => handle.invocationId
            );
          }
          const call = { ...target, outputSerde: restate.serde.binary };
          return req.awaitAtTheEnd
            ? restate.rpc.call<Uint8Array, Uint8Array>(call)
            : // The entry is created; nobody reads the result.
              restate.rpc.detached<Uint8Array, Uint8Array>(call);
        }),
        { concurrency: "unbounded", discard: true }
      )
    ),
  },
});

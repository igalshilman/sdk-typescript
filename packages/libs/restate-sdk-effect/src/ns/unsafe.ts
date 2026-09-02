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

// The `unsafe` namespace: escape hatches that step outside what this runtime
// can check. Reach for them when the typed surface genuinely cannot express
// what you need, and read what each one says about determinism first.

export { durable, rawContext } from "../ops.js";

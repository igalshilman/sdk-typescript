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

// The `diagnostics` namespace: observing the invocation rather than driving
// it. Nothing here should influence control flow — `isProcessing` in
// particular produces a journal mismatch by construction if you branch on it.

export { abortSignal, isProcessing } from "../ops.js";

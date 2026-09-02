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

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      // test-services/ imports this package by name (the container resolves it
      // through the workspace symlink). Point it at the source so e2e runs
      // never test a stale dist/.
      "@restatedev/restate-sdk-effect": path.resolve(
        import.meta.dirname,
        "src/index.ts"
      ),
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    envDir: ".",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // Run E2E tests serially to avoid LevelDB state conflicts
    fileParallelism: false,
    maxConcurrency: 1,
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["node_modules", "dist", "tests"],
      all: true,
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    },
    // Use tsconfig paths for module resolution
    alias: {
      "@/*": "/src/*",
    },
  },
});

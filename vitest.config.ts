import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["tests/integration/**/*.test.ts", "**/node_modules/**", "**/dist/**"],
    coverage: {
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        lines: 80,
        functions: 75,
        branches: 70,
        statements: 80
      }
    }
  }
});

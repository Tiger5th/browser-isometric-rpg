import { defineConfig } from "vitest/config";

export default defineConfig({
  // recast-navigation 的 WASM 入口需要绕过 Vite 预打包（官方 README 建议）。
  optimizeDeps: {
    exclude: ["recast-navigation", "@recast-navigation/core", "@recast-navigation/generators"],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

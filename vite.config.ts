import { readFile } from "node:fs/promises";

import { Compiler } from "inkjs/full";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/** package.json 的 version 注入运行时，标题画面右下角显示版本号（票 32）。 */
async function appVersionPlugin(): Promise<Plugin> {
  const pkg = (await readFile(new URL("./package.json", import.meta.url), "utf8")) as string;
  const version = (JSON.parse(pkg) as { version?: string }).version ?? "0.0.0";
  return {
    name: "app-version",
    config: () => ({
      define: { "import.meta.env.APP_VERSION": JSON.stringify(version) },
    }),
  };
}

/**
 * 构建/测试期把 `*.ink?ink` 编译为运行时可直接加载的 JSON 字符串。
 * ink 编译器（inkjs/full）只在 Vite 进程里使用，不会进入游戏运行时代码。
 */
function inkCompilePlugin(): Plugin {
  return {
    name: "content-ink-compile",
    enforce: "pre",
    async load(id) {
      const [file, query] = id.split("?", 2);
      if (query !== "ink" || !file.endsWith(".ink")) {
        return null;
      }
      const source = await readFile(file, "utf8");
      const compiler = new Compiler(source);
      const story = compiler.Compile();
      if (story === null || compiler.errors.length > 0) {
        const details = compiler.errors.join("\n");
        this.error(`ink 编译失败：${file}\n${details}`);
      }
      const json = story.ToJson();
      if (typeof json !== "string") {
        this.error(`ink 编译结果无法序列化：${file}`);
      }
      return `export default ${JSON.stringify(json)};`;
    },
  };
}

export default defineConfig({
  plugins: [inkCompilePlugin(), await appVersionPlugin()],
  // recast-navigation 的 WASM 入口需要绕过 Vite 预打包（官方 README 建议）。
  optimizeDeps: {
    exclude: ["recast-navigation", "@recast-navigation/core", "@recast-navigation/generators"],
  },
  test: {
    include: ["src/**/*.test.ts", "tools/**/*.test.mjs"],
    environment: "node",
  },
});

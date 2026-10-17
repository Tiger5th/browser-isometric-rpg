/**
 * `*.ink?ink` 由 vite.config.ts 的 ink-compile 插件在构建/测试期编译，
 * 默认导出是 inkjs 运行时可加载的 JSON 字符串。
 */
declare module "*.ink?ink" {
  const compiledJson: string;
  export default compiledJson;
}

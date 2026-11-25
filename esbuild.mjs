import { build, context } from "esbuild";

const options = {
  entryPoints: { extension: "src/extension/main.ts", service: "src/service/main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  logLevel: "info",
  // The Agent SDK reads import.meta.url, which CommonJS lacks.
  define: { "import.meta.url": "importMetaUrl", BUILD: JSON.stringify(new Date().toISOString()) },
  banner: { js: 'const importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
};

if (process.argv.includes("--watch")) await (await context(options)).watch();
else await build(options);

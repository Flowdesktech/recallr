import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/bin.ts", "src/mcp/server.ts", "src/server/server.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  external: [
    "@huggingface/transformers",
    "better-sqlite3",
    "imapflow",
    "mailparser",
  ],
  banner: ({ format }) => (format === "esm" ? { js: "" } : {}),
});

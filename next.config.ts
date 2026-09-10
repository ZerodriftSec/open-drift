import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const tracingExcludes = [
  "./.data/**/*",
  "./.git/**/*",
  "./docs/**/*",
  "./drizzle/**/*",
  "./mock/**/*",
  "./skills/**/*",
  "./tests/**/*",
  "./AGENTS.md",
  "./README.md",
  "./components.json",
  "./drizzle.config.ts",
  "./eslint.config.mjs",
  "./next.config.ts",
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": tracingExcludes,
    "next-server": tracingExcludes,
  },
  outputFileTracingIncludes: {
    "/*": [
      "./workflows/*.json",
      "./node_modules/@openai/codex/bin/**/*",
      "./node_modules/@openai/codex/package.json",
      "./node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex-*/package.json",
      "./node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex-*/vendor/**/*",
    ],
  },
  outputFileTracingRoot: projectRoot,
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex",
    "@openai/codex-sdk",
  ],
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;

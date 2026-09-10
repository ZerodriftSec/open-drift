import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import node from "eslint-plugin-n";
import unusedImports from "eslint-plugin-unused-imports";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "drizzle.config.ts",
            "eslint.config.mjs",
            "postcss.config.mjs",
            "scripts/*.mjs",
            "tailwind.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      n: node,
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "n/no-sync": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          args: "all",
          caughtErrors: "all",
          vars: "all",
        },
      ],
    },
  },
  globalIgnores([
    ".claude/**",
    ".next/**",
    ".data/**",
    "benchmark/**",
    "build/**",
    "coverage/**",
    "drizzle/**",
    "next-env.d.ts",
    "node_modules/**",
    "out/**",
    "skills/**",
  ]),
]);

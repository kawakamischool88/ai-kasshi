import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  /* サーバーのログへ本文・メールアドレス・鍵を出さないため、
     src/ では console を直接使わない。ログは src/lib/log.ts からだけ出す。 */
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/log.ts"],
    rules: { "no-console": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

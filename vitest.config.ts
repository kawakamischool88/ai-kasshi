import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // アプリと同じ「@/」の書き方をテストでも使えるようにする
    alias: { "@": path.resolve(here, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // 越境テストは実際の開発用 Supabase へ接続するため、余裕を持たせる
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // 同じユーザーの行を触るので並列にしない
    fileParallelism: false,
  },
});

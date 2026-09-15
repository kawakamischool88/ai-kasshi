import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 越境テストは実際の開発用 Supabase へ接続するため、余裕を持たせる
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // 同じユーザー行を触るので並列にしない
    fileParallelism: false,
  },
});

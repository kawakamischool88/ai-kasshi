/**
 * migration を当てる前の DB でも、控えと台帳を安全に作れるか（Phase F）。開発用 DB だけで確かめる。
 *
 * 開発用 DB には migration ①② が当たっているので、テスト用の
 * AI_KASSHI_TEST_HIDE_MIGRATIONS で「まだ当たっていない」状態をまねる（開発用でだけ使える）。
 * 控えと台帳は一時フォルダへ（AI_KASSHI_BACKUP_DIR）。本物の backups/ と本番には触れない。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES } from "../src/config/backup";
import { linkedTarget } from "../scripts/lib/target";

const M1 = "20260929000001";
const M2 = "20260929000002";
const NEW_TABLES = ["conversation_deletions", "maintenance_runs"];
const OLD_TABLES = BACKUP_TABLES.filter((t) => !NEW_TABLES.includes(t));

const dirs: string[] = [];
let printed = "";

type Manifest = {
  migrations: string[];
  tables: Record<string, number>;
  skippedTables: { table: string; migration: string; reason: string }[];
  testHiddenMigrations?: string[];
};

function backup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kasshi-premig-"));
  dirs.push(dir);
  const r = spawnSync("npx tsx scripts/backup.ts", {
    shell: true, encoding: "utf8", env: { ...process.env, AI_KASSHI_BACKUP_DIR: dir, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  printed += out;
  const folder = readdirSync(dir).find((f) => /^\d{4}-/.test(f));
  const manifestPath = folder ? path.join(dir, folder, "manifest.json") : "";
  const manifest = manifestPath && existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : null;
  const files = folder ? readdirSync(path.join(dir, folder)) : [];
  const ledgerFiles = existsSync(path.join(dir, "ledger", "dev")) ? readdirSync(path.join(dir, "ledger", "dev")) : [];
  return { code: r.status ?? -1, out, manifest, files, ledgerFiles };
}

beforeAll(() => {
  const t = linkedTarget();
  if (t.kind !== "dev") throw new Error(`中止：CLI が開発用を向いていません（${t.label}）`);
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("migration を当てる前の控え（開発用 DB で、未適用をまねる）", () => {
  it("①② 未適用 → 2表だけ外して成功。目録に外した2表と理由・実際の migration。既存の8表は控える。台帳は会話の削除だけ飛ばす", () => {
    const r = backup({ AI_KASSHI_TEST_HIDE_MIGRATIONS: `${M1},${M2}` });
    expect(r.code).toBe(0);
    const m = r.manifest!;
    expect(m.skippedTables.map((s) => [s.table, s.migration])).toEqual([
      ["conversation_deletions", M1],
      ["maintenance_runs", M2],
    ]);
    for (const s of m.skippedTables) expect(s.reason).toContain("まだ DB に適用されていない");
    expect(m.migrations).not.toContain(M1);
    expect(m.migrations).not.toContain(M2);
    expect(m.migrations.length).toBeGreaterThan(10);
    expect(m.testHiddenMigrations).toEqual([M1, M2]);
    expect(Object.keys(m.tables).sort()).toEqual([...OLD_TABLES].sort());
    for (const t of OLD_TABLES) expect(r.files, t).toContain(`${t}.jsonl`);
    for (const t of NEW_TABLES) expect(r.files, t).not.toContain(`${t}.jsonl`);
    expect(m.tables.messages).toBeGreaterThan(0);

    expect(r.out).toContain("会話の削除　　　 飛ばしました");
    expect(r.ledgerFiles).toContain("deletions.jsonl");
    expect(r.ledgerFiles).not.toContain("conversation-deletions.jsonl");
  }, 300_000);

  it("① だけ適用 → maintenance_runs だけ外す。台帳の会話の削除は飛ばさない", () => {
    const r = backup({ AI_KASSHI_TEST_HIDE_MIGRATIONS: M2 });
    expect(r.code).toBe(0);
    expect(r.manifest!.skippedTables.map((s) => s.table)).toEqual(["maintenance_runs"]);
    expect(r.manifest!.migrations).toContain(M1);
    expect(r.files).toContain("conversation_deletions.jsonl");
    expect(r.files).not.toContain("maintenance_runs.jsonl");
    expect(r.out).not.toContain("飛ばしました");
    expect(r.out).toMatch(/会話の削除　　　 いまDBに \d+ 件/);
    expect(r.ledgerFiles).toContain("conversation-deletions.jsonl");
  }, 300_000);

  it("①② 適用済み（ふだんどおり）→ 10表すべて控え、外した表は無い", () => {
    const r = backup();
    expect(r.code).toBe(0);
    expect(r.manifest!.skippedTables).toEqual([]);
    expect(r.manifest!.testHiddenMigrations).toBeUndefined();
    expect(r.manifest!.migrations).toEqual(expect.arrayContaining([M1, M2]));
    expect(Object.keys(r.manifest!.tables).sort()).toEqual([...BACKUP_TABLES].sort());
    for (const t of BACKUP_TABLES) expect(r.files, t).toContain(`${t}.jsonl`);
  }, 300_000);

  it("未適用をまねる設定は、本番とみなすと止まる（控えを作らない）", () => {
    const r = backup({ AI_KASSHI_TEST_HIDE_MIGRATIONS: M2, AI_KASSHI_TREAT_AS_PROD: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("中止：AI_KASSHI_TEST_HIDE_MIGRATIONS は、開発用のテストでだけ使えます");
    expect(r.manifest).toBeNull();
  }, 300_000);

  it("表示に本文・メールアドレスが出ていない", () => {
    expect(printed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(printed).not.toContain("kasshi-test");
  });
});

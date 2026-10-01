/**
 * どの表を控えるかを、DB の migration の状態から決める（Phase F）。
 *
 * 【なぜ要るか】
 * 控える表の一覧（BACKUP_TABLES）には、あとから migration で足した表も入っている。
 * その migration をまだ当てていない DB（例：migration を当てる前の本番）では、表そのものが無いため、
 * 控えを取ろうとすると全体が失敗していた（2026-10-01、本番の1回目の backup で実際に起きた）。
 *
 * 【決まり】本番かどうかでは分けない。DB の migration の状態だけで決める。
 *   ・その表を作る migration が未適用 → その表だけ外す（理由を目録に書く。本文は書かない）
 *   ・migration が適用済みなのに表が無い → 異常なので止まる（中身の欠けた控えを黙って作らない）
 *   ・最初からある表 → いつも必ず控える。無ければ止まる
 * migration を当てたあとは、何もしなくても全部の表が対象に戻る。
 */
import { BACKUP_TABLES, TABLE_INTRODUCED_BY, type BackupTable } from "../../src/config/backup";
import { runSql, lit } from "./db";
import { linkedTarget } from "./target";

export type SkippedTable = { table: BackupTable; migration: string; reason: string };
export type TablePlan = { include: BackupTable[]; skipped: SkippedTable[] };
export type MigrationState = { applied: string[]; existing: string[]; hidden: string[] };

/** 控える表を決める（DB につながない。テストから直接呼べる） */
export function planTables(
  applied: readonly string[],
  existing: readonly string[],
  tables: readonly BackupTable[] = BACKUP_TABLES,
): TablePlan {
  const appliedSet = new Set(applied);
  const existingSet = new Set(existing);
  const include: BackupTable[] = [];
  const skipped: SkippedTable[] = [];
  const missing: string[] = [];

  for (const table of tables) {
    const migration = TABLE_INTRODUCED_BY[table];
    if (migration && !appliedSet.has(migration)) {
      skipped.push({ table, migration, reason: `この表を作る migration（${migration}）が、まだ DB に適用されていないため` });
      continue;
    }
    if (existingSet.has(table)) include.push(table);
    else missing.push(table);
  }
  if (missing.length > 0) {
    throw new Error(
      `中止：migration は適用済み（または最初からある表）なのに、表がありません（${missing.join("、")}）。異常なので、控えは作りません。`,
    );
  }
  return { include, skipped };
}

/* 【テスト用】開発用 DB で「migration を当てる前」の状態をまねる。
   AI_KASSHI_TEST_HIDE_MIGRATIONS に migration の番号（, 区切り）を入れると、それを未適用として扱う。
   開発用でだけ使える。本番（または本番とみなすテスト）で付けたら止まる。 */
function hiddenMigrations(): string[] {
  const raw = process.env.AI_KASSHI_TEST_HIDE_MIGRATIONS;
  if (!raw) return [];
  if (linkedTarget().kind !== "dev" || process.env.AI_KASSHI_TREAT_AS_PROD === "1") {
    throw new Error("中止：AI_KASSHI_TEST_HIDE_MIGRATIONS は、開発用のテストでだけ使えます。");
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** DB の migration の一覧と、控える表のうち実際にある表を読む（名前だけ。本文は読まない） */
export function readMigrationState(): MigrationState {
  const hidden = hiddenMigrations();
  const applied = runSql<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  )
    .map((r) => r.version)
    .filter((v) => !hidden.includes(v));
  const existing = runSql<{ name: string }>(
    `select c.relname as name
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname in (${BACKUP_TABLES.map((t) => lit(t)).join(", ")})`,
  ).map((r) => r.name);
  return { applied, existing, hidden };
}

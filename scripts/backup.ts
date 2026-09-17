/**
 * バックアップを作る（Phase 4A）。
 *
 * 実行： npm run backup
 *
 * 【これは何か】
 * 障害が起きたときに、別の環境へ戻すための控え。
 * **本人がダウンロードするためのものではない**（それは Phase 4B）。
 *
 * 【作られるもの】
 *   backups/<日時>/
 *     manifest.json     … いつ・どの版で・何件控えたかの目録
 *     profiles.jsonl    … 表ごとに1ファイル（1行＝1件）
 *     conversations.jsonl
 *     ...
 *
 * 【鍵は入れない】
 * 作り終えたあと、鍵やAPIキーらしい文字が混ざっていないか必ず調べる。
 * 見つかったらファイルを消して止まる。
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  BACKUP_TABLES,
  BACKUP_FORMAT_VERSION,
  FORBIDDEN_IN_BACKUP,
  NOT_BACKED_UP,
} from "../src/config/backup";
import { runSql, ident } from "./lib/db";

loadEnv({ path: ".env.test.local", override: true });

const ROOT = path.resolve("backups");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  const startedAt = Date.now();
  const dir = path.join(ROOT, stamp());
  mkdirSync(dir, { recursive: true });
  console.log(`バックアップ先：${dir}\n`);

  // いま反映されている migration の一覧（復元先を同じ形にするために要る）
  const migrations = runSql<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  ).map((r) => r.version);

  const tables: Record<string, number> = {};
  let totalRows = 0;
  let totalBytes = 0;

  /* すべての表を1回のやりとりでまとめて取り出す。
     表ごとに1回ずつ聞くと、つなぎ直しに時間がかかるため。
     並びを id で固定して、毎回同じ順序になるようにする（見比べやすい）。 */
  const union = BACKUP_TABLES.map(
    (t) => `select '${t}' as tbl, to_jsonb(x) as row, x.id::text as sort_id from public.${ident(t)} x`,
  ).join("\nunion all\n");
  const all = runSql<{ tbl: string; row: unknown }>(
    `select tbl, row from (${union}) s order by tbl, sort_id`,
  );

  const byTable = new Map<string, unknown[]>();
  for (const t of BACKUP_TABLES) byTable.set(t, []);
  for (const r of all) byTable.get(r.tbl)?.push(r.row);

  for (const table of BACKUP_TABLES) {
    const rows = byTable.get(table) ?? [];
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    const file = path.join(dir, `${table}.jsonl`);
    writeFileSync(file, body, "utf8");

    tables[table] = rows.length;
    totalRows += rows.length;
    totalBytes += Buffer.byteLength(body, "utf8");
    console.log(`  ${table.padEnd(26)} ${String(rows.length).padStart(6)} 件`);
  }

  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    /** どの版のDBの形か。復元先は同じ版まで migration を流してから戻す */
    migrations,
    tables,
    totalRows,
    totalBytes,
    /** 控えていないものと、その理由 */
    notBackedUp: NOT_BACKED_UP,
    note:
      "運用・災害復旧用のバックアップ。本人向けのダウンロードではない。" +
      "鍵・APIキー・パスワードは含まない。",
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // ---- 鍵が混ざっていないか調べる ----
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), "utf8");
    for (const word of FORBIDDEN_IN_BACKUP) {
      if (text.includes(word)) found.push(`${name} に「${word}」`);
    }
  }

  if (found.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    console.error("\n中止：控えに入れてはいけない文字が見つかったため、作ったファイルを消しました。");
    for (const f of found) console.error(`  × ${f}`);
    process.exit(1);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n合計 ${totalRows} 件 / ${(totalBytes / 1024).toFixed(1)} KB / ${seconds} 秒`);
  console.log("鍵・APIキーらしい文字は見つかりませんでした。");
  console.log(`\n目録：${path.join(dir, "manifest.json")}`);
}

main();

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
import { runSql, ident, setSqlPurpose } from "./lib/db";
import { backupRoot } from "./lib/paths";
import { updateLedger } from "./lib/ledger-run";
import { linkedTarget } from "./lib/target";
import { runMain } from "./lib/safe-run";

loadEnv({ path: ".env.test.local", override: true });

// ふだんは作業フォルダの backups/。テストでは AI_KASSHI_BACKUP_DIR で一時フォルダに切り替える（Phase C）
const ROOT = backupRoot();

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  // 控えのファイルへ書くために、行を丸ごと読む（画面には件数だけ出す）（Phase E）
  setSqlPurpose("backup");
  const startedAt = Date.now();
  /* どの DB を控えるか（Phase D）。開発用か本番か分からないときは、控えを作らない
     （目録に向き先が書けないと、30日の片付けで判断できなくなるため） */
  const target = linkedTarget();
  if (target.kind === "unknown") {
    console.error(`中止：CLI がどの DB を向いているか分かりません（${target.label}）。npm run where で確かめてください。`);
    process.exit(1);
  }
  const dir = path.join(ROOT, stamp());
  mkdirSync(dir, { recursive: true });
  console.log(`バックアップ先：${dir}`);
  console.log(`控える DB　　：${target.label}\n`);

  /* 中身が空でも「成功」にしてよいか。
     本当に空のDB（作りたて等）を控えるときだけ付ける。 */
  const allowEmpty = process.argv.includes("--allow-empty");

  // いま反映されている migration の一覧（復元先を同じ形にするために要る）
  const migrations = runSql<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  ).map((r) => r.version);

  /* 【空の控えを作らないための歯止め①】
     migration は、どんなDBでも必ず1件以上ある。
     ここが0件なら、DBが空なのではなく**読めていない**。
     （2026-09-21、CLIの出力形式の違いで「読めない＝0件」になる不具合があった） */
  if (migrations.length === 0) {
    console.error("中止：migration の一覧が0件でした。");
    console.error("  どんなDBでも必ず1件以上あるはずなので、読み取りに失敗しています。");
    console.error("  控えは作りません（空の控えを作らないため）。");
    process.exit(1);
  }

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

  /* 【空の控えを作らないための歯止め②】
     全部の表を合わせて0件なら、いったん止める。
     本当に空のDBを控えたいときは --allow-empty を付ける。 */
  if (totalRows === 0 && !allowEmpty) {
    rmSync(dir, { recursive: true, force: true });
    console.error("\n中止：すべての表が0件でした。作りかけのファイルは消しました。");
    console.error("  読み取りに失敗している可能性があります（空の控えは最も危ない）。");
    console.error("  本当に空のDBを控えるときは、末尾に --allow-empty を付けてください。");
    process.exit(1);
  }

  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    /** どの DB の控えか（Phase D）。開発用／本番と、人が読む名前・場所だけ。番号・URL・鍵は書かない */
    target: { kind: target.kind, name: target.name, place: target.place },
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

  /* 【控えと台帳は、必ず一緒に作る】（Phase D ／ R6）
     控えだけ取って台帳を作り忘れると、控えのあとに本人が消したものを当て直せない。 */
  console.log("\n続けて、台帳を更新します。\n");
  updateLedger();
}

// 失敗しても、本文を含みうる SQL のエラーの詳細は表示しない（Phase C）
runMain(main);

/**
 * 台帳を書き出す（Phase 4A）。
 *
 * 実行： npm run ledger
 *
 * 【なぜ普通のバックアップと分けるのか】
 * 古いバックアップだけを戻すと、**そのあとに行った削除まで巻き戻る**。
 * 本人が消したはずの記憶が、復活してしまう。
 *
 * そこで「削除した」「訂正した」という事実だけを、
 * バックアップとは別の**足していくだけのファイル**に貯めておく。
 * このファイルは復元で上書きされない。復元のたびに、これを当て直す。
 *
 * 【足していくだけ】
 * すでに書いてある行は消さない・書き換えない。
 * DBを古い状態に戻しても、この台帳は縮まない。
 *
 * 【削除台帳に本文は入れない】
 * 消した内容を別の場所に残したら、消した意味がない。
 * 入れるのは、削除をもう一度当てるのに要る id と日時だけ。
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { LEDGERS, LEDGER_FORMAT_VERSION } from "../src/config/backup";
import { runSql } from "./lib/db";

loadEnv({ path: ".env.test.local", override: true });

const DIR = path.resolve("backups", "ledger");

type Row = Record<string, unknown>;

/** すでに台帳にある鍵を読み出す（二重に書かないため） */
function existingKeys(file: string, key: readonly string[]): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      keys.add(key.map((k) => String(row[k])).join("|"));
    } catch {
      // 読めない行は無視する（足すだけなので、既存の行は壊さない）
    }
  }
  return keys;
}

function appendRows(file: string, key: readonly string[], rows: Row[]): number {
  const known = existingKeys(file, key);
  const fresh = rows.filter((r) => !known.has(key.map((k) => String(r[k])).join("|")));
  if (fresh.length === 0) return 0;

  const body = fresh.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(file, body, "utf8");
  return fresh.length;
}

function main() {
  mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();

  // ---------- 削除台帳（本文なし） ----------
  const d = LEDGERS.deletions;
  const deletions = runSql<Row>(
    `select ${d.fields.join(", ")} from public.memory_deletions order by deleted_at`,
  ).map((r) => ({ ...r, ledgerVersion: LEDGER_FORMAT_VERSION, recordedAt: now }));

  const addedDeletions = appendRows(path.join(DIR, d.file), d.key, deletions);

  // 念のため、本文らしい欄が混ざっていないか確かめる
  for (const row of deletions) {
    for (const k of Object.keys(row)) {
      if (/text|content|body|suggested|confirmed_text|reason|title/i.test(k)) {
        console.error(`中止：削除台帳に本文らしい欄「${k}」が混ざっています。`);
        process.exit(1);
      }
    }
  }

  // ---------- 変更台帳（訂正・考えの変化） ----------
  /* 削除台帳だけでは、バックアップ後に行った訂正を戻せない。
     古い（間違っていた）内容が「いま有効」として復活してしまう。
     こちらは訂正後の本文を含む。本人のいま有効な内容だから。 */
  const r = LEDGERS.revisions;
  const revisions = runSql<Row>(
    `select
       id, user_id, conversation_id, source_message_id, candidate_index,
       revision_of, revision_kind, version, revised_at, confirmed_at,
       origin, requested_by_user,
       coalesce(confirmed_text, suggested_text) as text
     from public.memory_candidates
     where revision_of is not null
     order by revised_at`,
  ).map((row) => ({ ...row, ledgerVersion: LEDGER_FORMAT_VERSION, recordedAt: now }));

  const addedRevisions = appendRows(path.join(DIR, r.file), r.key, revisions);

  console.log(`台帳：${DIR}`);
  console.log(`  削除台帳　 いまDBに ${deletions.length} 件 ／ 台帳へ新たに ${addedDeletions} 件`);
  console.log(`  変更台帳　 いまDBに ${revisions.length} 件 ／ 台帳へ新たに ${addedRevisions} 件`);
  console.log("\n台帳は足していくだけです。DBを古い状態に戻しても、この中身は減りません。");
}

main();

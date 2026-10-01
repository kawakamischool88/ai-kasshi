/**
 * 完全削除した利用者の行が、全部の表で0件かを確かめる（運営者用・Phase D ／ D4）。
 *
 * 実行： npm run account:verify-deleted -- <確認用の8文字>
 *
 * 誰のことかは、完全削除の台帳から、確認用の8文字で探す（メールアドレスは使わない・表示しない）。
 * 読み取りだけ。表示するのは表ごとの件数だけ。
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { LEDGERS } from "../src/config/backup";
import { allCountedTables, countsFor, sum } from "./lib/account";
import { readLedgerFile } from "./lib/ledger-file";
import { ledgerDir } from "./lib/paths";
import { runMain } from "./lib/safe-run";
import { linkedTarget } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

function main() {
  const prefix = (process.argv[2] ?? "").trim().toLowerCase();
  const target = linkedTarget();
  console.log("完全削除の確かめ（読み取りだけ）");
  console.log(`  対象の DB：${target.label}`);

  if (!/^[0-9a-f]{8}$/.test(prefix)) {
    console.error("\n× 確認用の8文字（0-9・a-f）を指定してください。");
    process.exit(1);
  }
  const rows = readLedgerFile(path.join(ledgerDir(), LEDGERS.accountDeletions.file)).filter((r) =>
    String(r.user_id).startsWith(prefix),
  );
  if (rows.length !== 1) {
    console.error(`\n× 完全削除の台帳で、1人に決まりません（${rows.length} 人）。`);
    process.exit(1);
  }

  const counts = countsFor(String(rows[0].user_id));
  console.log(`  完全削除した日時：${new Date(String(rows[0].deleted_at)).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n`);
  for (const t of allCountedTables()) {
    const n = counts[t.label];
    console.log(`  ${n === 0 ? "○" : "×"} ${t.label.padEnd(32)} ${String(n).padStart(6)} 件`);
  }
  const total = sum(counts);
  console.log("");
  if (total !== 0) {
    console.error(`× その人にひも付く行が ${total} 件残っています。`);
    process.exit(1);
  }
  console.log("○ その人にひも付く行は、すべての表で0件です。");
}

runMain(main);

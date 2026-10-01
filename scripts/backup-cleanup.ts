/**
 * 運営バックアップの30日の片付け（Phase D ／ D2・D5）。
 *
 * 実行（表示だけ）： npm run backup:cleanup
 * 実行（消す）　　： npm run backup:cleanup -- --yes
 * 本番の控えも消す： npm run backup:cleanup -- --yes --prod
 *
 * 【消すもの】
 *   ① backups/ 直下の控えのうち、目録の作成日時から30日を過ぎたもの
 *   ② アカウントの完全削除の台帳のうち、38日を過ぎた行
 *
 * 【消さないもの・止まる条件】
 *   ・ledger/（台帳）の中身は、②の行を除いて絶対に触れない
 *   ・リンクはたどらない。名前・目録・向き先がおかしいものは自動で消さない（運営者が確かめる）
 *   ・30日以内の本番の控えが1つも無いのに、本番の古い控えを消そうとしたら止まる（全部消えるのを防ぐ）
 *     → 先に npm run backup で新しい控えを取ってから、もう一度実行する
 *
 * 【表示するのは】フォルダ名・作成日時・開発用／本番・件数だけ。本文は開かない。
 * DB には触れない（ファイルだけを見る）。
 */
import { lstatSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_LEDGER_DAYS, BACKUP_RETENTION_DAYS, LEDGERS } from "../src/config/backup";
import { BACKUP_DIR_NAME, planCleanup, splitAccountLedger } from "./lib/cleanup";
import { readLedgerFile, rewriteLedgerSafely } from "./lib/ledger-file";
import { backupRoot, ledgerRoot } from "./lib/paths";
import { runMain } from "./lib/safe-run";

function jst(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—";
}

const KIND_LABEL = { dev: "開発用", prod: "本番", unknown: "不明" } as const;

function main() {
  const yes = process.argv.includes("--yes");
  const prodOk = process.argv.includes("--prod");
  const now = new Date();
  const root = backupRoot();

  console.log(`運営バックアップの片付け（${yes ? "消す" : "表示だけ"}）`);
  console.log(`  置き場所：${root}`);
  console.log(`  残す日数：控え ${BACKUP_RETENTION_DAYS}日 ／ 完全削除の台帳 ${ACCOUNT_LEDGER_DAYS}日\n`);

  // ---------- ① 控え ----------
  const plan = planCleanup(root, now, BACKUP_RETENTION_DAYS);
  if (plan.entries.length === 0) console.log("  控えはありません。");
  for (const e of plan.entries) {
    const mark = e.decision === "delete" ? "消す候補" : e.decision === "keep" ? "残す　　" : "手で確認";
    const age = e.ageDays == null ? "" : `（${Math.floor(e.ageDays)}日前）`;
    const rows = e.totalRows == null ? "—" : `${e.totalRows}件`;
    console.log(`  ${mark}  ${e.name}  ${KIND_LABEL[e.kind]}  ${jst(e.createdAt)}${age}  ${rows}  … ${e.reason}`);
  }

  const toDelete = plan.entries.filter((e) => e.decision === "delete");
  const prodDelete = toDelete.filter((e) => e.kind === "prod");
  console.log(`\n  消す候補：${toDelete.length} 件（うち本番 ${prodDelete.length} 件）／ 30日以内の本番の控え：${plan.recentProd} 件`);

  if (plan.prodBlocked) {
    console.error("\n× 止めます：30日以内の本番の控えが1つもありません。このまま消すと、本番の控えが無くなります。");
    console.error("  先に npm run backup（本番を向けて）で新しい控えを取ってから、もう一度実行してください。");
    process.exit(1);
  }

  // ---------- ② 完全削除の台帳 ----------
  const accountFiles = (["dev", "prod"] as const)
    .map((k) => ({ kind: k, file: path.join(ledgerRoot(), k, LEDGERS.accountDeletions.file) }))
    .filter((f) => existsSync(f.file));
  const accountPlans = accountFiles.map((f) => {
    const rows = readLedgerFile(f.file);
    return { ...f, total: rows.length, ...splitAccountLedger(rows, now, ACCOUNT_LEDGER_DAYS) };
  });
  for (const a of accountPlans) {
    console.log(
      `  完全削除の台帳（${KIND_LABEL[a.kind]}）：${a.total} 行 ／ ${ACCOUNT_LEDGER_DAYS}日を過ぎた行 ${a.expired.length} 行`,
    );
  }

  if (!yes) {
    console.log("\n表示だけで終わりました（何も消していません）。");
    console.log("  消すときは：npm run backup:cleanup -- --yes" + (prodDelete.length || accountPlans.some((a) => a.kind === "prod" && a.expired.length) ? " --prod" : ""));
    return;
  }

  const prodTouched = prodDelete.length > 0 || accountPlans.some((a) => a.kind === "prod" && a.expired.length > 0);
  if (prodTouched && !prodOk) {
    console.error("\n× 止めます：本番の控え（または本番の完全削除の台帳）を消す候補があります。本番も消すときは --prod も付けてください。");
    process.exit(1);
  }

  // ---------- 消す ----------
  let deleted = 0;
  for (const e of toDelete) {
    const full = path.join(root, e.name);
    // 消す直前にもう一度確かめる（名前の形・リンクでないこと・フォルダであること）
    const st = lstatSync(full);
    if (!BACKUP_DIR_NAME.test(e.name) || st.isSymbolicLink() || !st.isDirectory() || e.name === "ledger") {
      console.error(`  × ${e.name} は消しません（確かめ直しで対象外になった）`);
      continue;
    }
    rmSync(full, { recursive: true });
    deleted += 1;
  }

  let pruned = 0;
  for (const a of accountPlans) {
    if (a.expired.length === 0) continue;
    rewriteLedgerSafely(a.file, a.keep, (reread) => {
      if (reread.length !== a.keep.length) throw new Error("中止：完全削除の台帳の書き直しで、行数が合いません。");
    });
    pruned += a.expired.length;
  }

  console.log(`\n消しました：控え ${deleted} 件 ／ 完全削除の台帳の古い行 ${pruned} 行`);
}

runMain(main);

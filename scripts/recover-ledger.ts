/**
 * 本番を Supabase の物理バックアップで古い時点へ戻した「直後」にだけ使う、台帳の当て直し（Phase D ／ N-5・D7）。
 *
 * 【これは何のためのものか】
 * 物理バックアップ（毎日・7日保持）で本番を戻すと、そのあとに本人が消した記憶・会話、
 * ［残さない］と決めた候補、完全に消した利用者が、本番に戻ってしまう。
 * それを台帳で消し直すためだけの命令。**ふだんの運用で本番へ書き込むための道具ではない。**
 *
 * 【手順（この命令の前に）】
 *   1. いまの本番 DB が読めるなら、先に npm run backup（本番を向けて）で最新の控えと台帳を作る
 *   2. Vercel の AI_KASSHI_MODE=restore で、利用者の画面と有料のAI処理を止める
 *   3. Supabase の画面で、物理バックアップから本番を戻す（戻した時点の日時を控える）
 *   4. CLI を本番に向ける（npm run where で確かめる）
 *   5. この命令を、まず表示だけで実行 → 件数を確かめる → 実行
 *   6. 点検（この命令が続けて必ず行う）が全項目 ○ になってから、AI_KASSHI_MODE を外す
 *
 * 【使い方】
 *   表示だけ： npm run recover:ledger -- --restored-to <戻した時点の日時（ISO）>
 *   実行　　： npm run recover:ledger -- --restored-to <日時> --yes --prod
 *                --confirm-project ai-kasshi-prod --app-stopped
 *
 * 【守り】
 *   ・CLI が本番を向いていなければ止まる（練習用の「模擬」は下を参照）
 *   ・--yes・--prod・--confirm-project（本番のプロジェクト名の打ち直し）・--app-stopped（画面を止めた確認）が全部そろわないと実行しない
 *   ・--restored-to が無い・未来・8日より前（物理バックアップは7日）なら止まる
 *   ・本番 DB に「戻した時点より1時間以上あとの記録」があれば止まる（＝戻した直後ではない、ふだんの本番に当てようとしている）
 *   ・当て直したあと、点検を必ず行う。1つでも × なら失敗で終わる
 *   ・表示するのは件数だけ。本文は表示しない
 *
 * 【模擬（テスト用）】
 * 環境変数 AI_KASSHI_RECOVER_SIMULATE=1 を付けると、開発用 DB の隔離した場所（restore）へ、
 * 本番と同じ守りを通して当てる。本番には一切触れない。
 */
import { config as loadEnv } from "dotenv";
import { RESTORE_SCHEMA } from "../src/config/backup";
import { runSql, setSqlPurpose } from "./lib/db";
import { applyLedgers, planLedgers, readAllLedgers } from "./lib/ledger-apply";
import { runVerify } from "./lib/verify";
import { runMain } from "./lib/safe-run";
import { linkedTarget } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

function stop(message: string): never {
  console.error(`\n× 止めます：${message}`);
  process.exit(1);
}

function jst(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function main() {
  // 本文を消す当て直しと「本文が無いこと」を数える点検のため（本文は画面に出さない）（Phase E）
  setSqlPurpose("recover-apply");
  /* 模擬（開発用 DB でだけ動く）：
       "1"      … 隔離した場所（restore）へ当てる（テスト）
       "public" … 開発用の public へ当てる（本番復旧の予行演習。Phase E ／ K2。本番と同じ public の道を通る） */
  const simulateMode = process.env.AI_KASSHI_RECOVER_SIMULATE;
  const simulate = simulateMode === "1" || simulateMode === "public";
  const yes = process.argv.includes("--yes");
  const prodFlag = process.argv.includes("--prod");
  const appStopped = process.argv.includes("--app-stopped");
  const confirmProject = argValue("--confirm-project");
  const restoredToRaw = argValue("--restored-to");

  const target = linkedTarget();
  const S = simulateMode === "1" ? RESTORE_SCHEMA : "public";

  console.log(
    `本番の復旧：台帳の当て直し（${yes ? "実行" : "表示だけ"}）` +
      (simulateMode === "1" ? "【模擬・開発用の restore へ】" : simulateMode === "public" ? "【予行演習・開発用の public へ】" : ""),
  );
  console.log(`  対象の DB：${target.label}`);
  console.log(`  当てる先：${S}`);
  if (!simulate) console.log("  ★ 本番です。物理バックアップから本番を戻した直後にだけ使います。");

  // ---------- 向き先 ----------
  if (simulate) {
    if (target.kind !== "dev") stop("模擬は開発用でだけ動きます。");
  } else if (target.kind !== "prod") {
    stop("CLI が本番を向いていません。この命令は本番の復旧のためだけのものです（開発用の復元は npm run restore:ledger）。");
  }

  // ---------- 戻した時点 ----------
  if (!restoredToRaw) stop("--restored-to に、物理バックアップで戻した時点の日時を入れてください。");
  const restoredTo = new Date(restoredToRaw).getTime();
  if (Number.isNaN(restoredTo)) stop("--restored-to の日時が読めません。");
  const now = Date.now();
  if (restoredTo > now + 5 * 60 * 1000) stop("--restored-to が未来の日時です。");
  if (restoredTo < now - 8 * DAY) stop("--restored-to が8日より前です（物理バックアップは7日分）。日時を確かめてください。");
  console.log(`  戻した時点：${jst(restoredTo)}`);

  // DB の中の、いちばん新しい記録（件数を数えるのと同じく、日時だけ読む）
  const [row] = runSql<{ newest: string | null }>(`
    select greatest(
      (select max(created_at) from ${S}.messages),
      (select max(created_at) from ${S}.ai_usage),
      (select max(created_at) from ${S}.memory_candidates),
      (select max(last_message_at) from ${S}.conversations)
    ) as newest`);
  const newest = row?.newest ? new Date(row.newest).getTime() : null;
  console.log(`  DB のいちばん新しい記録：${newest ? jst(newest) : "なし"}`);
  if (newest && newest > restoredTo + HOUR) {
    stop(
      "DB に、戻した時点より1時間以上あとの記録があります。物理バックアップから戻した直後ではない可能性があります。" +
        "ふだんの本番に当てる道具ではありません。",
    );
  }

  // ---------- 台帳 ----------
  const ledgers = readAllLedgers();
  const recorded = [ledgers.accounts, ledgers.revisions, ledgers.deletions, ledgers.convDeletions, ledgers.closures]
    .flat()
    .map((r) => new Date(String(r.recordedAt ?? "")).getTime())
    .filter((t) => !Number.isNaN(t));
  const lastRecorded = recorded.length ? Math.max(...recorded) : null;
  console.log(`  台帳を最後に更新した日時：${lastRecorded ? jst(lastRecorded) : "なし"}`);
  if (!lastRecorded || lastRecorded < restoredTo) {
    console.log("  △ 台帳が、戻した時点より古いです。当て直すものが無い（または取りこぼしがある）かもしれません。");
  }

  // ---------- 当て直す予定の件数 ----------
  const plan = planLedgers(S);
  console.log("\n  当て直す予定（件数）：");
  for (const [k, v] of Object.entries(plan)) console.log(`    ${k}：${v} 件`);

  if (!yes) {
    console.log("\n表示だけで終わりました（何も変えていません）。");
    console.log(
      `  実行：npm run recover:ledger -- --restored-to ${restoredToRaw} --yes --prod --confirm-project ${target.name} --app-stopped`,
    );
    return;
  }

  // ---------- 実行の前の守り ----------
  if (!prodFlag) stop("--prod が付いていません。");
  if (confirmProject !== target.name) stop("--confirm-project のプロジェクト名が一致しません。");
  if (!appStopped) stop("--app-stopped が付いていません。Vercel の AI_KASSHI_MODE=restore で画面と有料のAI処理を止めてから実行してください。");

  console.log("");
  applyLedgers(S);

  // ---------- 点検（必ず） ----------
  console.log("\n続けて、点検します。");
  // public（本番・予行演習）は本番と同じ点検（API の項目を省き、ログイン情報も数える）
  const ok = runVerify(S, { production: S === "public" });
  if (!ok) stop("点検で異常がありました。利用を再開してはいけません。");
  console.log("\n○ 当て直しと点検が終わりました。AI_KASSHI_MODE を外す前に、画面でも確かめてください。");
}

runMain(main);

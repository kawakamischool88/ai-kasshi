/**
 * アカウントの完全削除（運営者用・Phase D ／ D3〜D6）。
 *
 * 【実行してよいのは、次をすべて済ませたときだけ】
 *   ・対面または電話などで、運営者が本人だと確かめた（メール・メッセージだけでは実行しない）
 *   ・本人が「停止して残す」ではなく「全部削除」を選んだ
 *   ・希望があれば、本人が自分の画面から ZIP を書き出した（運営者は受け取らない・開かない）
 *   ・依頼を受けた日を記録した（30日以内に削除を終える）
 *
 * 【使い方】
 *   ① 表示だけ（既定）： npm run account:delete -- <メールアドレス>
 *   ② 実行　　　　　　： npm run account:delete -- <メールアドレス> --yes --confirm <①で出た確認用の8文字>
 *      本番はさらに --prod
 *
 * 【守り】
 *   ・対象が0人・2人以上なら止まる ／ 管理者は消せない
 *   ・①の表示の確認用の8文字を打ち直さないと実行しない
 *   ・消す前に、完全削除の台帳（番号と日時だけ）へ書く。書けなければ消さない
 *   ・消したあと、その人の行が全部の表で0件か、ほかの利用者の件数が変わっていないかを確かめる
 *   ・台帳から、その人の行を消す（完全削除の台帳の1行だけが、38日間その人を守る）
 *
 * 【表示するのは】開発用／本番・人数・確認用の8文字・登録日・表ごとの件数だけ。
 * 入力したメールアドレスを画面に出し直さない。本文は読まない。
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { LEDGERS, LEDGER_FORMAT_VERSION } from "../src/config/backup";
import { runSql, lit, setSqlPurpose } from "./lib/db";
import { allCountedTables, countsFor, sum, totals } from "./lib/account";
import { appendNewRows, readLedgerFile, rewriteLedgerSafely } from "./lib/ledger-file";
import { ledgerDir } from "./lib/paths";
import { runMain } from "./lib/safe-run";
import { emailFromArgOrPrompt } from "./lib/ask-email";
import { linkedTarget } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

function jst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

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

async function main() {
  // メールアドレスで利用者を探すため（返すのは番号と登録日だけ）（Phase E）
  setSqlPurpose("account-lookup");
  const argEmail = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== argValue("--confirm"));
  const yes = process.argv.includes("--yes");
  const prodFlag = process.argv.includes("--prod");
  const confirm = argValue("--confirm");

  const target = linkedTarget();
  console.log(`アカウントの完全削除（${yes ? "実行" : "表示だけ"}）`);
  console.log(`  対象の DB：${target.label}`);
  if (target.kind === "prod") console.log("  ★ 本番です");

  if (target.kind !== "dev" && target.kind !== "prod") stop("CLI がどの DB を向いているか分かりません（npm run where）。");
  /* 実在の人のアドレスは、命令の後ろに書かせず、ここで聞く（履歴・記録・AIツールに残さないため）。
     引数で受け取れるのは、テスト用の架空のアドレス（@example.com）だけ（Phase E） */
  const email = await emailFromArgOrPrompt(argEmail);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    stop("メールアドレスの形になっていません（入力した内容は表示しません）。");
  }

  // ---------- 対象を探す（メールアドレスは画面に出さない） ----------
  const found = runSql<{ id: string; created_at: string }>(
    `select id, created_at from auth.users where lower(email) = lower(${lit(email)})`,
  );
  console.log(`\n  見つかった人数：${found.length} 人`);
  if (found.length !== 1) stop(found.length === 0 ? "対象が見つかりません。" : "対象が1人に決まりません。");

  const user = found[0];
  const shortId = user.id.slice(0, 8);
  const [role] = runSql<{ role: string | null }>(`select role from public.profiles where id = ${lit(user.id)}`);
  if (role?.role === "admin") stop("この利用者は管理者です。管理者は完全削除できません。");

  const mine = countsFor(user.id);
  console.log(`  確認用の番号（先頭8文字）：${shortId}`);
  console.log(`  登録日：${jst(user.created_at)}`);
  console.log("  この人にひも付く行の件数：");
  for (const t of allCountedTables()) console.log(`    ${t.label.padEnd(32)} ${String(mine[t.label]).padStart(6)} 件`);

  if (!yes) {
    console.log("\n表示だけで終わりました（何も消していません）。");
    console.log("  本人確認・本人の選択・ZIP の希望の確認が済んでいれば、次で実行します：");
    console.log(
      `  npm run account:delete -- --yes --confirm ${shortId}${target.kind === "prod" ? " --prod" : ""}（メールアドレスは、もう一度聞かれたら入力）`,
    );
    return;
  }

  // ---------- 実行の前の守り ----------
  if (confirm !== shortId) stop("確認用の8文字が一致しません（表示だけで出た8文字を --confirm に入れてください）。");
  if (target.kind === "prod" && !prodFlag) stop("本番です。本番で消すときは --prod も付けてください。");
  if (target.kind === "dev" && prodFlag) stop("開発用を向いているのに --prod が付いています。向き先を確かめてください。");

  const before = totals();

  // ---------- 消す前に、完全削除の台帳へ書く（書けなければ消さない） ----------
  const dir = ledgerDir();
  const accountFile = path.join(dir, LEDGERS.accountDeletions.file);
  const deletedAt = new Date().toISOString();
  appendNewRows(accountFile, LEDGERS.accountDeletions.key, [
    { user_id: user.id, deleted_at: deletedAt, ledgerVersion: LEDGER_FORMAT_VERSION, recordedAt: deletedAt },
  ]);
  const written = readLedgerFile(accountFile).some((r) => r.user_id === user.id);
  if (!written) stop("完全削除の台帳に書けませんでした。消していません。");
  console.log("\n  完全削除の台帳に書きました（番号と日時だけ）。");

  // ---------- 消す（ログイン情報を消すと、その人の行はすべての表から連鎖して消える） ----------
  runSql(`delete from auth.users where id = ${lit(user.id)}; select 1 as ok;`);

  // ---------- 確かめる ----------
  const after = countsFor(user.id);
  const left = sum(after);
  const nowTotals = totals();
  /* ログイン中の記録（sessions など）は、ほかの人がログインするだけで増減するので見比べない。
     見比べるのは、利用者の登録と、利用者のデータの表だけ */
  const VOLATILE = new Set(["auth.sessions", "auth.refresh_tokens", "auth.one_time_tokens", "auth.flow_state", "auth.mfa_factors"]);
  const othersChanged = allCountedTables().filter(
    (t) => !VOLATILE.has(t.label) && nowTotals[t.label] !== before[t.label] - mine[t.label],
  );
  console.log(`  その人にひも付く行（消したあと）：${left} 件`);
  console.log(`  ほかの利用者の件数が変わった表：${othersChanged.length} 表`);

  // ---------- 台帳から、その人の行を消す（D6） ----------
  let tidied = 0;
  for (const def of [LEDGERS.deletions, LEDGERS.revisions, LEDGERS.conversationDeletions, LEDGERS.closures]) {
    const file = path.join(dir, def.file);
    const rows = readLedgerFile(file);
    const keep = rows.filter((r) => r.user_id !== user.id);
    if (keep.length === rows.length) continue;
    rewriteLedgerSafely(file, keep, (reread) => {
      if (reread.some((r) => r.user_id === user.id)) throw new Error("中止：台帳の書き直しで、その人の行が残っています。");
    });
    tidied += rows.length - keep.length;
  }
  console.log(`  台帳から消したその人の行：${tidied} 行（完全削除の台帳の1行だけが残る）`);

  if (left !== 0 || othersChanged.length > 0) {
    stop("確かめで異常がありました。上の件数を見てください。");
  }
  console.log(`\n○ 完全削除が終わりました。念のため：npm run account:verify-deleted -- ${shortId}`);
  console.log("  運営バックアップに残った分は、30日の保持期限で順に消えます（backup:cleanup）。");
  console.log("  完了したことを本人へ連絡し、依頼の記録に完了日を書いてください。");
}

runMain(main);

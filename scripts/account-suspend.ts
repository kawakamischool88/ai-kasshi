/**
 * 利用の停止・再開（運営者用・Phase E ／ E5「停止して残す」）。
 *
 * 【何をするか】
 *   停止：その人が新しくログインできないようにし（Supabase の「利用停止（ban）」の期限を遠い未来に）、
 *         いまのログインも切る（ログイン中の記録を消す）。**データは何も消さない。**
 *   再開：利用停止を外す。本人は、ふだんどおりメールの6桁コードでログインし直せる。
 *
 * 【使い方】
 *   表示だけ（既定）： npm run account:suspend
 *   停止する　　　　： npm run account:suspend -- --yes --confirm <表示で出た確認用の8文字>
 *   再開する　　　　： npm run account:suspend -- --resume --yes --confirm <8文字>
 *   本番はさらに --prod
 *   メールアドレスは、実行したあとに聞かれるので入力する（命令の後ろに書かない。テスト用の @example.com だけ書ける）
 *
 * 【守り】account:delete と同じ（1人に決まらない・管理者なら止まる・8文字の打ち直し・本番は --prod）。
 * 【表示】開発用／本番・人数・確認用の8文字・登録日・いまの状態・ログイン中の数だけ。
 *
 * 【注意】停止しても、本人の手元に発行済みのログインの鍵は、最長1時間（鍵の期限）まで形の上では有効。
 * ログイン中の記録を消すので、その鍵を更新して使い続けることはできない。
 */
import { config as loadEnv } from "dotenv";
import { runSql, lit, setSqlPurpose } from "./lib/db";
import { emailFromArgOrPrompt } from "./lib/ask-email";
import { runMain } from "./lib/safe-run";
import { linkedTarget } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

/** 停止の期限。Supabase の画面の「利用停止」と同じ仕組み（期限の日時）を、遠い未来にする */
const SUSPEND_UNTIL = "2999-12-31T00:00:00Z";

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

function jst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

type State = { banned_until: string | null; sessions: number };

function stateOf(id: string): State {
  const [s] = runSql<State>(`
    select (select banned_until from auth.users where id = ${lit(id)}) as banned_until,
           (select count(*) from auth.sessions where user_id = ${lit(id)})::int as sessions`);
  return s;
}

function label(s: State): string {
  const suspended = s.banned_until && new Date(s.banned_until).getTime() > Date.now();
  return suspended ? "停止中" : "利用中";
}

async function main() {
  // メールアドレスで利用者を探すため（返すのは番号と登録日だけ）
  setSqlPurpose("account-lookup");
  const resume = process.argv.includes("--resume");
  const yes = process.argv.includes("--yes");
  const prodFlag = process.argv.includes("--prod");
  const confirm = argValue("--confirm");
  const argEmail = process.argv.slice(2).find((a) => !a.startsWith("--") && a !== confirm);

  const target = linkedTarget();
  console.log(`利用の${resume ? "再開" : "停止"}（${yes ? "実行" : "表示だけ"}）`);
  console.log(`  対象の DB：${target.label}`);
  if (target.kind === "prod") console.log("  ★ 本番です");
  if (target.kind !== "dev" && target.kind !== "prod") stop("CLI がどの DB を向いているか分かりません（npm run where）。");

  const email = await emailFromArgOrPrompt(argEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) stop("メールアドレスの形になっていません（入力した内容は表示しません）。");

  const found = runSql<{ id: string; created_at: string }>(
    `select id, created_at from auth.users where lower(email) = lower(${lit(email)})`,
  );
  console.log(`\n  見つかった人数：${found.length} 人`);
  if (found.length !== 1) stop(found.length === 0 ? "対象が見つかりません。" : "対象が1人に決まりません。");
  const user = found[0];
  const shortId = user.id.slice(0, 8);
  const [role] = runSql<{ role: string | null }>(`select role from public.profiles where id = ${lit(user.id)}`);
  if (role?.role === "admin") stop("この利用者は管理者です。管理者は、この命令で停止できません。");

  const before = stateOf(user.id);
  console.log(`  確認用の番号（先頭8文字）：${shortId}`);
  console.log(`  登録日：${jst(user.created_at)}`);
  console.log(`  いまの状態：${label(before)} ／ ログイン中：${before.sessions} 件`);

  if (!yes) {
    console.log("\n表示だけで終わりました（何も変えていません）。");
    console.log(
      `  実行：npm run account:suspend --${resume ? " --resume" : ""} --yes --confirm ${shortId}${target.kind === "prod" ? " --prod" : ""}（メールアドレスは、聞かれたら入力）`,
    );
    return;
  }
  if (confirm !== shortId) stop("確認用の8文字が一致しません。");
  if (target.kind === "prod" && !prodFlag) stop("本番です。本番で変えるときは --prod も付けてください。");
  if (target.kind === "dev" && prodFlag) stop("開発用を向いているのに --prod が付いています。向き先を確かめてください。");

  if (resume) {
    runSql(`update auth.users set banned_until = null where id = ${lit(user.id)}; select 1 as ok;`);
  } else {
    runSql(`
      update auth.users set banned_until = ${lit(SUSPEND_UNTIL)} where id = ${lit(user.id)};
      delete from auth.sessions where user_id = ${lit(user.id)};
      select 1 as ok;`);
  }

  const after = stateOf(user.id);
  console.log(`\n  変えたあとの状態：${label(after)} ／ ログイン中：${after.sessions} 件`);
  const ok = resume ? label(after) === "利用中" : label(after) === "停止中" && after.sessions === 0;
  if (!ok) stop("状態が思ったとおりになっていません。");
  console.log(
    resume
      ? "○ 再開しました。本人は、ふだんどおりメールの6桁コードでログインできます。"
      : "○ 停止しました（データは何も消していません）。再開するときは --resume を付けて実行します。",
  );
}

runMain(main);

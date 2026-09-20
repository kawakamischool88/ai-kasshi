/**
 * 招待：ログインを許可するメールアドレスを登録する。
 *
 * 実行： npm run invite -- someone@example.com
 *
 * 新規登録は Supabase 側で止めているため、ここで登録した人だけがログインできる。
 * 登録後、本人はログイン画面でメールアドレスを入れると 6桁コードが届く。
 *
 * service_role を使うのは scripts/ と tests/ だけ（アプリ本体では使わない）。
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { linkedTarget, stopIfNotDev } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

/* ① この命令は .env.test.local（開発用）を見る。
      そこが開発用でなければ止める。 */
stopIfNotDev("test", "npm run invite");

/* ② CLI が本番を向いているときも止める。

   ①だけでは、いちばん起きやすい事故を防げない。
   「本番の作業中（CLI＝本番）に npm run invite と打つ」と、
   この命令は .env.test.local を見るので**開発用に人が作られ**、
   本番には何も起きないまま「登録しました」と出てしまう。
   本人は本番に登録できたつもりになる。

   本番の登録は Supabase の画面から行うと決めたので、ここで止める。 */
const linked = linkedTarget();
if (linked.kind !== "dev") {
  console.error("");
  console.error("──────────────────────────────────────────");
  console.error("  中止しました：npm run invite は開発用でしか使えません");
  console.error("──────────────────────────────────────────");
  console.error(`  いまCLIが向いているのは：${linked.label}`);
  console.error("");
  console.error("  この命令は .env.test.local（開発用）を見ます。");
  console.error("  そのまま実行すると、**開発用に人が作られるだけ**で、");
  console.error("  本番には何も登録されません。");
  console.error("");
  console.error("  本番へ登録するときは、Supabase の画面から行ってください：");
  console.error("    Authentication → Users → Add user → Send invitation");
  console.error("");
  console.error("  いまの向き先は  npm run where  で確認できます。");
  console.error("");
  process.exit(1);
}

const email = process.argv[2]?.trim();
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("使い方： npm run invite -- メールアドレス");
  process.exit(1);
}
if (!url || !serviceKey) {
  console.error("中止：SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.test.local にありません。");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: existing, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  if (existing.users.some((u) => u.email === email)) {
    console.log(`すでに登録済み：${email}`);
    return;
  }
  // パスワードは付けない。ログインは 6桁コードのみ
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  console.log(`登録しました：${email} (${data.user.id})`);
  console.log("ログイン画面でこのメールアドレスを入力すると、6桁コードが届きます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

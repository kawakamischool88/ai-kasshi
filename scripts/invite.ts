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

loadEnv({ path: ".env.test.local", override: true });

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

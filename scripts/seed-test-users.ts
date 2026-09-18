/**
 * 架空ユーザー A・B を「開発用」Supabase に作る。
 *
 * 実行： npm run seed
 *
 * 【重要】
 * - service_role キーを使う唯一の場所は scripts/ と tests/ だけ。アプリ本体では使わない。
 * - 本番プロジェクトへ誤って流さないよう、SEED_TARGET=dev が無いと動かない。
 * - メールアドレスは実在しない example.com。本人の実データは一切含まない。
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { stopIfNotDev } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

/* 開発用（ai-kasshi-dev）を向いていなければ、その場で止める。
   架空ユーザーを本番へ作ってしまうと、あとから取り除くのが面倒になる。 */
stopIfNotDev("test", "npm run seed");

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.SEED_TARGET !== "dev") {
  console.error("中止：.env.test.local に SEED_TARGET=dev が無いため実行しません（本番への誤投入防止）。");
  process.exit(1);
}
if (!url || !serviceKey) {
  console.error("中止：SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.test.local にありません。");
  process.exit(1);
}

export const TEST_USERS = [
  { key: "A", email: "kasshi-test-a@example.com", displayName: "テスト利用者A" },
  { key: "B", email: "kasshi-test-b@example.com", displayName: "テスト利用者B" },
] as const;

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const passwordA = process.env.TEST_USER_A_PASSWORD;
  const passwordB = process.env.TEST_USER_B_PASSWORD;
  if (!passwordA || !passwordB) {
    console.error("中止：TEST_USER_A_PASSWORD / TEST_USER_B_PASSWORD を .env.test.local に設定してください（テスト専用の適当な文字列で可）。");
    process.exit(1);
  }
  const passwords = { A: passwordA, B: passwordB } as const;

  const { data: existing, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;

  for (const u of TEST_USERS) {
    const found = existing.users.find((x) => x.email === u.email);
    if (found) {
      const { error } = await admin.auth.admin.updateUserById(found.id, {
        password: passwords[u.key],
        email_confirm: true,
        user_metadata: { display_name: u.displayName },
      });
      if (error) throw error;
      console.log(`更新：${u.key} ${u.email} (${found.id})`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password: passwords[u.key],
        email_confirm: true,
        user_metadata: { display_name: u.displayName },
      });
      if (error) throw error;
      console.log(`作成：${u.key} ${u.email} (${data.user.id})`);
    }
  }
  console.log("完了：架空ユーザー A・B が開発用 Supabase に揃いました。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

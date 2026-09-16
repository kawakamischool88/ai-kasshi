/**
 * 開発用：架空ユーザー A・B の会話・発言・利用量を消す。
 *
 * 実行： npm run reset:test
 *
 * テストを何度も回すと、架空ユーザーの記録がたまって
 * 「利用状況」画面が読みにくくなるため。
 *
 * 【安全のため】
 * - .env.test.local に SEED_TARGET=dev が無いと動かない
 * - 消すのは @example.com の架空ユーザーの行だけ。実在の人の記録には触れない
 * - service_role を使うのは scripts/ と tests/ だけ（アプリ本体では使わない）
 */
import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.SEED_TARGET !== "dev") {
  console.error("中止：.env.test.local に SEED_TARGET=dev が無いため実行しません。");
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
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;

  const fake = data.users.filter((u) => u.email?.endsWith("@example.com"));
  if (fake.length === 0) {
    console.log("架空ユーザーが見つかりませんでした。");
    return;
  }

  for (const u of fake) {
    // 会話を消すと、ぶら下がる発言も一緒に消える
    const conv = await admin.from("conversations").delete().eq("user_id", u.id).select("id");
    if (conv.error) throw conv.error;
    const usage = await admin.from("ai_usage").delete().eq("user_id", u.id).select("id");
    if (usage.error) throw usage.error;
    console.log(
      `${u.email}：会話 ${conv.data?.length ?? 0} 件 / 利用記録 ${usage.data?.length ?? 0} 件を削除`,
    );
  }

  // 残っていないか確かめる
  for (const table of ["conversations", "messages", "ai_usage"] as const) {
    const { count } = await admin.from(table).select("*", { count: "exact", head: true });
    console.log(`  残り ${table}: ${count ?? 0} 件`);
  }
  console.log("完了：架空ユーザーのテストデータを消しました。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

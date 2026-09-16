/**
 * 開発用：架空ユーザーのログイン用6桁コードを取り出す。
 *
 * 実行： npm run dev:otp -- kasshi-test-a@example.com
 *
 * 架空ユーザー（@example.com）はメールが届かないため、
 * 実際のログイン画面を Chrome で通すときにこのコードを使う。
 * 安全のため @example.com 以外のアドレスには使えないようにしてある
 * （本人・実在の人のコードをここから取り出せないようにする）。
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

if (!email || !email.endsWith("@example.com")) {
  console.error("使い方： npm run dev:otp -- 架空ユーザーのメール（@example.com のみ）");
  process.exit(1);
}
if (process.env.SEED_TARGET !== "dev" || !url || !serviceKey) {
  console.error("中止：.env.test.local の SEED_TARGET=dev / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を確認してください。");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const otp = data.properties?.email_otp;
  if (!otp) throw new Error("コードを取得できませんでした");
  console.log(`6桁コード（${email}）: ${otp}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

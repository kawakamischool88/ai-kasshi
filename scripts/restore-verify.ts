/**
 * 戻した場所（restore）を点検する（Phase 4A・Phase C・Phase D）。
 *
 * 実行： npm run restore:verify
 *
 * 点検の中身は scripts/lib/verify.ts を参照。
 * すべて「異常なし」になるまで、利用を再開してはいけない。
 */
import { config as loadEnv } from "dotenv";
import { RESTORE_SCHEMA } from "../src/config/backup";
import { runVerify } from "./lib/verify";
import { runMain } from "./lib/safe-run";

loadEnv({ path: ".env.test.local", override: true });

function main() {
  if (!runVerify(RESTORE_SCHEMA)) process.exit(1);
}

// 失敗しても、本文を含みうる SQL のエラーの詳細は表示しない（Phase C）
runMain(main);

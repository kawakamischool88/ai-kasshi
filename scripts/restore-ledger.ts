/**
 * 戻した場所（restore）へ、台帳を当て直す（Phase 4A・Phase C・Phase D）。
 *
 * 実行： npm run restore:ledger
 *
 * 当てる順番と中身は scripts/lib/ledger-apply.ts を参照。
 * 開発用（ai-kasshi-dev）を向いていなければ、その場で止める（restore スキーマを書き換えるため）。
 * 本番を物理バックアップで戻した直後に本番へ当てるときは、別の命令 npm run recover:ledger を使う。
 */
import { config as loadEnv } from "dotenv";
import { RESTORE_SCHEMA } from "../src/config/backup";
import { applyLedgers } from "./lib/ledger-apply";
import { runMain } from "./lib/safe-run";
import { stopIfNotDev } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

function main() {
  stopIfNotDev("cli", "npm run restore:ledger");
  applyLedgers(RESTORE_SCHEMA);
  console.log("  次： npm run restore:verify");
}

runMain(main);

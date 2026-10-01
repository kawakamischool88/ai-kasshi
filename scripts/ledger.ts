/**
 * 台帳を書き出す（Phase 4A・Phase C・Phase D）。
 *
 * 実行： npm run ledger
 *
 * 中身は scripts/lib/ledger-run.ts を参照。
 * npm run backup を実行すると、控えを取った直後にこれも必ず動く（Phase D ／ R6）。
 * 復旧の前に、いまの DB が読めるなら、必ずこれで台帳を最新にしてから戻す。
 */
import { config as loadEnv } from "dotenv";
import { updateLedger } from "./lib/ledger-run";
import { setSqlPurpose } from "./lib/db";
import { runMain } from "./lib/safe-run";

loadEnv({ path: ".env.test.local", override: true });

// 変更台帳へ、消していない訂正の本文を書くため（画面には件数だけ出す）（Phase E）
setSqlPurpose("ledger");
runMain(updateLedger);

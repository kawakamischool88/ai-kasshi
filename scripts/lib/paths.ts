/**
 * バックアップと台帳を置く場所（Phase C・Phase D）。
 *
 * ふだんは作業フォルダの `backups/`（git には入らない）。
 * テストでは、環境変数 AI_KASSHI_BACKUP_DIR で別の一時フォルダに切り替え、
 * **本物の台帳を書き換えない**ようにする。
 *
 * 【台帳は、開発用と本番で分ける】（Phase D）
 *   backups/ledger/dev/   開発用 DB の台帳
 *   backups/ledger/prod/  本番 DB の台帳
 * 混ぜると、戻すときに「別の DB の利用者」の記録を入れようとして失敗する。
 * どちらかは、CLI のリンク先（npm run where の ①）で決める。分からなければ止まる。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { linkedTarget, type Kind } from "./target";

export function backupRoot(): string {
  return path.resolve(process.env.AI_KASSHI_BACKUP_DIR || "backups");
}

/** 台帳の置き場所の親（ledger/）。backup:cleanup は、ここに絶対に触れない */
export function ledgerRoot(): string {
  return path.join(backupRoot(), "ledger");
}

/** 開発用・本番の台帳の置き場所 */
export function ledgerDir(kind?: Kind): string {
  const k = kind ?? linkedTarget().kind;
  if (k !== "dev" && k !== "prod") {
    throw new Error("中止：CLI がどの DB を向いているか分からないため、台帳の置き場所を決められません（npm run where）。");
  }
  // 以前の置き方（ledger/ の直下に台帳）が残っていたら止める。混ざらないよう、運営者に移してもらう
  const root = ledgerRoot();
  if (existsSync(root) && readdirSync(root).some((f) => f.endsWith(".jsonl"))) {
    throw new Error(
      "中止：台帳が以前の置き方（ledger/ の直下）で残っています。" +
        "どちらの DB の台帳かを確かめて、ledger/dev/ または ledger/prod/ へ移してください。",
    );
  }
  return path.join(root, k);
}

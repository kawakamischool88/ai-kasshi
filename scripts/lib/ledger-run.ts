/**
 * 台帳を書き出す（Phase 4A・Phase C）。
 *
 * 実行： npm run ledger（npm run backup でも、控えを取った直後に必ず呼ばれる）
 *
 * 【なぜ普通のバックアップと分けるのか】
 * 古いバックアップだけを戻すと、**そのあとに行った削除・判断まで巻き戻る**。
 * 本人が消したはずの記憶や会話、［残さない］と決めた候補が、復活してしまう。
 *
 * そこで「消した」「直した」「残さないと決めた」という事実だけを、
 * バックアップとは別の**足していくだけのファイル**に貯めておく。
 * このファイルは復元で上書きされない。復元のたびに、これを当て直す。
 *
 * 【台帳の種類】
 *   deletions.jsonl               記憶の削除（本文なし）
 *   conversation-deletions.jsonl  会話の削除（本文・見出しなし）          … Phase C
 *   closures.jsonl                ［残さない］の判断（本文・理由なし）     … Phase C
 *   revisions.jsonl               訂正・考えの変化（いま有効な版だけ本文あり）
 *
 * 【足していくだけ。ただし1つだけ例外（G2）】
 * 本人が記憶の系列を消したら、変更台帳にあるその系列の**本文だけ**を消す。
 * 行・番号・版のつながり・日時は残す（戻すときの順番とつながりに要る）。
 * 書き直しは一時ファイル → 確かめる → 置き換える、の順で行い、途中で止まっても元の台帳は壊れない。
 * 消した系列の行に本文が1つでも残っていたら、成功にしない。
 *
 * 【表示するのは件数だけ】
 * 本文・理由・メールアドレスは表示しない。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LEDGERS, LEDGER_FORMAT_VERSION } from "../../src/config/backup";
import { runSql } from "./db";
import { planTables, readMigrationState, type MigrationState } from "./backup-plan";
import { ledgerDir } from "./paths";
import {
  appendNewRows,
  countTextInDeleted,
  readLedgerFile,
  rewriteLedgerSafely,
  scrubRevisionRows,
  type Row,
} from "./ledger-file";
import { linkedTarget } from "./target";

/** 本文らしい欄の名前（本文を持たない台帳に、紛れ込んでいないか調べる） */
const TEXT_LIKE = /text|content|body|suggested|confirmed_text|reason|title|proposed|email/i;

function assertNoTextColumns(label: string, rows: Row[]) {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (TEXT_LIKE.test(k)) {
        throw new Error(`中止：${label}に本文らしい欄「${k}」が混ざっています。`);
      }
    }
  }
}

/**
 * 台帳を更新する（npm run ledger と npm run backup の両方から呼ぶ）。
 * @param state DB の migration の状態（backup が読んだものを渡す。無ければここで読む）
 */
export function updateLedger(state: MigrationState = readMigrationState()): void {
  const DIR = ledgerDir();
  mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();
  const stamp = (r: Row): Row => ({ ...r, ledgerVersion: LEDGER_FORMAT_VERSION, recordedAt: now });

  console.log(`台帳を更新します（読むDB：${linkedTarget().label}）\n`);

  // ---------- ① 記憶の削除（本文なし） ----------
  const d = LEDGERS.deletions;
  const deletions = runSql<Row>(
    `select ${d.fields.join(", ")} from public.memory_deletions order by deleted_at`,
  ).map(stamp);
  assertNoTextColumns("削除台帳", deletions);
  const addedDeletions = appendNewRows(path.join(DIR, d.file), d.key, deletions);

  // ---------- ② 会話の削除（本文・見出しなし） ----------
  /* この表を作る migration（Phase A）が未適用の DB では、表も記録もまだ無いので飛ばす（Phase F）。
     適用済みなのに表が無ければ、planTables が止める */
  const cd = LEDGERS.conversationDeletions;
  const convPlan = planTables(state.applied, state.existing, ["conversation_deletions"]);
  const convSkipped = convPlan.skipped[0] ?? null;
  const convDeletions = convSkipped
    ? []
    : runSql<Row>(`select ${cd.fields.join(", ")} from public.conversation_deletions order by deleted_at`).map(stamp);
  assertNoTextColumns("会話の削除の台帳", convDeletions);
  const addedConv = convSkipped ? 0 : appendNewRows(path.join(DIR, cd.file), cd.key, convDeletions);

  // ---------- ③ ［残さない］の判断（本文・理由なし） ----------
  const cl = LEDGERS.closures;
  const closures = runSql<Row>(
    `select id, user_id, conversation_id, source_message_id, candidate_index, status,
            coalesce(confirmed_at, created_at) as decided_at
     from public.memory_candidates
     where status = 'rejected'
     order by decided_at`,
  ).map(stamp);
  assertNoTextColumns("［残さない］の台帳", closures);
  const addedClosures = appendNewRows(path.join(DIR, cl.file), cl.key, closures);

  // ---------- ④ 訂正・考えの変化 ----------
  /* いま有効な版（と、消していない訂正前・以前の考え）は本文あり。
     消した系列の版は、DB でも本文が無いので、台帳にも本文なしで入る。 */
  const r = LEDGERS.revisions;
  const revisions = runSql<Row>(
    `select
       id, user_id, conversation_id, source_message_id, candidate_index,
       revision_of, revision_kind, version, revised_at, confirmed_at,
       origin, requested_by_user,
       case when status = 'deleted' then null else coalesce(confirmed_text, suggested_text) end as text,
       (status = 'deleted') as deleted,
       deleted_at
     from public.memory_candidates
     where revision_kind is not null
     order by revised_at`,
  ).map(stamp);
  const revFile = path.join(DIR, r.file);
  const addedRevisions = appendNewRows(revFile, r.key, revisions);

  // ---------- ⑤ 消した系列の本文を、変更台帳から消す（G2） ----------
  const deletedMap = new Map<string, string | null>();
  for (const row of readLedgerFile(path.join(DIR, d.file))) {
    deletedMap.set(String(row.memory_id), (row.deleted_at as string | null) ?? null);
  }
  // DB で削除済みの版も（台帳の順番がずれても取りこぼさないように）
  for (const row of revisions) {
    if (row.deleted === true && !deletedMap.has(String(row.id))) {
      deletedMap.set(String(row.id), (row.deleted_at as string | null) ?? null);
    }
  }

  const current = readLedgerFile(revFile);
  const { rows: scrubbedRows, scrubbed } = scrubRevisionRows(current, deletedMap);
  if (scrubbed > 0) {
    rewriteLedgerSafely(revFile, scrubbedRows, (reread) => {
      const left = countTextInDeleted(reread, deletedMap);
      if (left > 0) throw new Error(`中止：書き直した変更台帳に、消した系列の本文が ${left} 件残っています。`);
    });
  }

  // 書き直しの有無にかかわらず、最後にもう一度確かめる（成功扱いにする条件）
  const finalRows = readLedgerFile(revFile);
  const leftText = countTextInDeleted(finalRows, deletedMap);
  if (leftText > 0) {
    throw new Error(`中止：変更台帳に、消した系列の本文が ${leftText} 件残っています。`);
  }

  console.log(`台帳の場所：${DIR}`);
  console.log(`  記憶の削除　　　 いまDBに ${deletions.length} 件 ／ 台帳へ新たに ${addedDeletions} 件`);
  console.log(
    convSkipped
      ? `  会話の削除　　　 飛ばしました … ${convSkipped.reason}（表がまだ無く、記録も無い）`
      : `  会話の削除　　　 いまDBに ${convDeletions.length} 件 ／ 台帳へ新たに ${addedConv} 件`,
  );
  console.log(`  ［残さない］　　 いまDBに ${closures.length} 件 ／ 台帳へ新たに ${addedClosures} 件`);
  console.log(`  訂正・考えの変化 いまDBに ${revisions.length} 件 ／ 台帳へ新たに ${addedRevisions} 件`);
  console.log(`  消した系列の本文を変更台帳から消した：${scrubbed} 件`);
  console.log(`  変更台帳で、消した系列に本文が残っている行：${leftText} 件`);
  console.log("\n台帳は足していくだけです（消した系列の本文を消すときだけ書き直します）。");
}


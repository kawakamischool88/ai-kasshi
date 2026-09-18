/**
 * 戻した場所へ、台帳（消した・直した事実）を当て直す（Phase 4A）。
 *
 * 実行： npm run restore:ledger
 *
 * 【なぜ要るのか】
 * 古いバックアップを戻しただけだと、
 * **控えを取ったあとに本人が消した記憶が復活してしまう**。
 * 直した記憶も、間違っていた古い内容のほうが「いま有効」に戻ってしまう。
 *
 * 台帳はバックアップとは別に足していくだけのファイルなので、
 * 古い状態へ戻しても縮まない。それをここで当て直す。
 *
 * 【当てる順番】
 * ① 変更（訂正・考えの変化） … 古い内容を無効にし、新しい内容を入れる
 * ② 削除                     … 本文を消し、会話の文脈からも外す
 * 直したあとに消した記憶もあるので、変更 → 削除の順にする。
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEDGERS, RESTORE_SCHEMA as S } from "../src/config/backup";
import { runSql, lit } from "./lib/db";
import { stopIfNotDev } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

const DIR = path.resolve("backups", "ledger");

type Row = Record<string, unknown>;

function readLedger(file: string): Row[] {
  const full = path.join(DIR, file);
  if (!existsSync(full)) return [];
  return readFileSync(full, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

/** その記憶に関係する古いやりとりを、AIへ送らないようにする（本体と同じ考え方） */
function excludeContextSql(memoryId: string, reason: string): string {
  return `
    with target as (
      select m.id, m.user_id, m.conversation_id, m.source_message_id,
             (select created_at from ${S}.messages where id = m.source_message_id) as src_at
      from ${S}.memory_candidates m where m.id = ${lit(memoryId)}
    )
    update ${S}.messages msg
    set excluded_from_ai_at = now(), exclusion_reason = ${lit(reason)}
    from target t
    where msg.excluded_from_ai_at is null
      and msg.user_id = t.user_id
      and (
        msg.id = t.source_message_id
        or msg.id = (
          select id from ${S}.messages
          where conversation_id = t.conversation_id and role = 'assistant' and created_at > t.src_at
          order by created_at limit 1
        )
        or msg.id in (select message_id from ${S}.memory_references where memory_id = t.id)
      );`;
}

function main() {
  /* 開発用（ai-kasshi-dev）を向いていなければ、その場で止める。
     この命令は restore スキーマの中身を書き換えるので、本番のDBに対して走らせてはいけない。 */
  stopIfNotDev("cli", "npm run restore:ledger");

  const revisions = readLedger(LEDGERS.revisions.file);
  const deletions = readLedger(LEDGERS.deletions.file);

  console.log(`台帳：${DIR}`);
  console.log(`  変更 ${revisions.length} 件 ／ 削除 ${deletions.length} 件\n`);

  // いま戻した場所にある id を調べておく
  const present = new Set(
    runSql<{ id: string }>(`select id from ${S}.memory_candidates`).map((r) => r.id),
  );
  const messages = new Set(
    runSql<{ id: string }>(`select id from ${S}.messages`).map((r) => r.id),
  );
  const conversations = new Set(
    runSql<{ id: string }>(`select id from ${S}.conversations`).map((r) => r.id),
  );

  // =========================================================
  // ① 変更（訂正・考えの変化）を当てる
  // =========================================================
  const sql: string[] = ["begin;", "set constraints all deferred;"];
  let addedRevision = 0;
  let neutralized = 0;
  const reattached: string[] = [];
  const skipped: string[] = [];

  // 古い順に当てる（何度も直された記憶があっても、順番どおりになる）
  const sortedRevisions = [...revisions].sort(
    (a, b) => String(a.revised_at ?? "").localeCompare(String(b.revised_at ?? "")),
  );

  for (const r of sortedRevisions) {
    const id = String(r.id);
    const oldId = String(r.revision_of);
    const kind = String(r.revision_kind);
    const newStatus = kind === "correction" ? "superseded" : "archived";

    if (!present.has(oldId)) {
      // 直す前の記憶が控えに無い＝控えより後に作られて直された。当てるものがない
      skipped.push(`${id}（直す前の記憶が控えにない）`);
      continue;
    }

    /* 直したときの会話・発言が控えに無いことがある（控えより後の出来事なので）。
       そのときは、**元の記憶と同じ会話・発言に付け直す**。
       新しい内容を失わないことを優先する。 */
    let convId = String(r.conversation_id);
    let msgId = String(r.source_message_id);
    if (!conversations.has(convId) || !messages.has(msgId)) {
      const [fallback] = runSql<{ conversation_id: string; source_message_id: string }>(
        `select conversation_id, source_message_id from ${S}.memory_candidates where id = ${lit(oldId)}`,
      );
      if (!fallback) {
        skipped.push(`${id}（付け直す先が見つからない）`);
        continue;
      }
      convId = fallback.conversation_id;
      msgId = fallback.source_message_id;
      reattached.push(id);
    }

    if (!present.has(id)) {
      // 直したあとの記憶そのものが控えに無い＝控えより後の訂正。ここで入れ直す
      sql.push(`
        insert into ${S}.memory_candidates (
          id, user_id, conversation_id, source_message_id, candidate_index,
          suggested_text, confirmed_text, origin, requested_by_user,
          status, confirmed_at, revised_at, version, revision_of, revision_kind
        ) values (
          ${lit(id)}, ${lit(r.user_id)}, ${lit(convId)}, ${lit(msgId)},
          ${lit(r.candidate_index ?? 1)},
          ${lit(r.text)}, ${lit(r.text)}, ${lit(r.origin ?? "self_experience")},
          ${lit(r.requested_by_user ?? true)},
          'confirmed', ${lit(r.confirmed_at)}, ${lit(r.revised_at)},
          ${lit(r.version ?? 2)}, ${lit(oldId)}, ${lit(kind)}
        )
        on conflict (id) do nothing;`);
      addedRevision += 1;
      present.add(id);
    }

    // 直す前の記憶を無効にする（＝間違っていた内容が「いま有効」に戻らない）
    sql.push(`
      update ${S}.memory_candidates
      set status = ${lit(newStatus)}, superseded_by = ${lit(id)}, revised_at = ${lit(r.revised_at)}
      where id = ${lit(oldId)} and status = 'confirmed';`);
    sql.push(excludeContextSql(oldId, kind === "correction" ? "corrected" : "updated"));
    neutralized += 1;
  }

  // =========================================================
  // ② 削除を当てる
  // =========================================================
  let deletedApplied = 0;
  let deletedAbsent = 0;

  for (const d of deletions) {
    const memoryId = String(d.memory_id);
    if (!present.has(memoryId)) {
      deletedAbsent += 1;
      continue;
    }

    // 先に、その記憶に関係する古いやりとりを文脈から外す（本文を消す前に）
    sql.push(excludeContextSql(memoryId, "deleted"));

    sql.push(`
      update ${S}.memory_candidates
      set status = 'deleted', suggested_text = null, confirmed_text = null,
          extraction_reason = null, deleted_at = ${lit(d.deleted_at)}
      where id = ${lit(memoryId)} and status <> 'deleted';`);

    // 出典は墓標として残す（本文は無い）
    sql.push(`
      update ${S}.memory_references
      set memory_deleted_at = ${lit(d.deleted_at)}
      where memory_id = ${lit(memoryId)} and memory_deleted_at is null;`);

    // 削除の記録そのものも入れ直す（台帳が正、DBが従）
    sql.push(`
      insert into ${S}.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope, deleted_at)
      values (${lit(d.user_id)}, ${lit(memoryId)}, ${lit(d.source_message_id)},
              ${lit(d.conversation_id)}, ${lit(d.scope)}, ${lit(d.deleted_at)})
      on conflict (user_id, memory_id) do nothing;`);

    deletedApplied += 1;
  }

  sql.push("commit;");
  runSql(sql.join("\n"));

  // =========================================================
  // 報告
  // =========================================================
  console.log("① 変更（訂正・考えの変化）");
  console.log(`   古い内容を無効にした　　　　：${neutralized} 件`);
  console.log(`   新しい内容を入れ直した　　　：${addedRevision} 件`);
  if (reattached.length > 0) {
    console.log(`   元の会話へ付け直した　　　　：${reattached.length} 件`);
    console.log("     （直したときの会話が控えより後のため、元の記憶と同じ会話に付けました）");
  }
  if (skipped.length > 0) {
    console.log(`   当てられなかった　　　　　　：${skipped.length} 件`);
    for (const s of skipped) console.log(`     ・${s}`);
  }

  console.log("\n② 削除");
  console.log(`   当てた　　　　　　　　　　　：${deletedApplied} 件`);
  console.log(`   控えに無く、当てる必要なし　：${deletedAbsent} 件`);

  console.log("\n当て終えました。まだ利用を再開してはいけません。");
  console.log("  次： npm run restore:verify");
}

main();

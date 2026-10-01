/**
 * 台帳を当てる処理の本体（Phase 4A・Phase C・Phase D）。
 *
 * 呼ぶのは次の2つだけ。当てる先と、本番かどうかの確認は、呼ぶ側で行う。
 *   scripts/restore-ledger.ts … 隔離した場所（restore）へ。開発用でだけ動く
 *   scripts/recover-ledger.ts … 本番を物理バックアップで戻した直後の public へ。何重ものガードの後だけ
 *
 * 【当てる順番】
 *   ⓪ 完全削除                38日以内に完全に消した利用者を消し直す（Phase D）
 *   ① 変更（訂正・考えの変化）  版の番号の順。消していない訂正は本文あり、消した系列の版は本文なし・削除
 *   ② 記憶の削除               本文なしの削除・AIへ送らない印・提案の文章の案と理由を消す
 *   ③ 会話の削除               別の会話の返事に印 → 会話を消す
 *   ④ ［残さない］             本文なし・理由なしの「残さない」に戻す
 *   ⑤ 期限切れ                 期限を過ぎた確認待ちを、本文なしの「期限切れ」に
 *   ⑥ 仕上げの見直し           系列の片方・消えた記憶を使った返事・消えた記憶への提案
 * すべて1つのまとまり（トランザクション）で行い、途中で失敗したら何も当てない。
 *
 * 【表示するのは件数だけ】本文・理由・提案の文章・メールアドレスは表示しない。
 */
import path from "node:path";
import { ACCOUNT_LEDGER_DAYS, LEDGERS } from "../../src/config/backup";
import { runSql, lit } from "./db";
import { ledgerDir } from "./paths";
import { readLedgerFile } from "./ledger-file";

/** その記憶に関係する古いやりとりを、AIへ送らないようにする（本体と同じ考え方） */
function excludeContextSql(S: string, memoryId: string, reason: string): string {
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

/**
 * 件数を控える更新文を作る。
 * `ctes` は「… u as (update … returning 1)」で終わる WITH の中身。
 * 件数は一時的な表に控え、最後にまとめて読む（1回の呼び出しで返るのは最後の文の結果だけのため）。
 */
function counted(ord: number, label: string, ctes: string, recursive = false): string {
  return `with ${recursive ? "recursive " : ""}${ctes}
    insert into _restore_counts select ${ord}, ${lit(label)}, count(*)::int from u;`;
}

/** 台帳を読む（番号と日時だけ。本文は、消していない訂正の変更台帳にだけある） */
export function readAllLedgers() {
  const DIR = ledgerDir();
  return {
    dir: DIR,
    accounts: readLedgerFile(path.join(DIR, LEDGERS.accountDeletions.file)),
    revisions: readLedgerFile(path.join(DIR, LEDGERS.revisions.file)),
    deletions: readLedgerFile(path.join(DIR, LEDGERS.deletions.file)),
    convDeletions: readLedgerFile(path.join(DIR, LEDGERS.conversationDeletions.file)),
    closures: readLedgerFile(path.join(DIR, LEDGERS.closures.file)),
  };
}

/** 完全に消した利用者の番号（アカウント削除の台帳。38日を過ぎた行は数えない） */
export function deletedAccounts(accounts: Record<string, unknown>[], now = new Date()): Set<string> {
  const limit = now.getTime() - ACCOUNT_LEDGER_DAYS * 24 * 60 * 60 * 1000;
  return new Set(
    accounts
      .filter((r) => new Date(String(r.deleted_at)).getTime() >= limit)
      .map((r) => String(r.user_id)),
  );
}

/** 利用者ごとの行を持つ表（完全削除で、その人の行を消す対象）。子の表から順 */
export const USER_TABLES: { table: string; column: string }[] = [
  { table: "ai_usage", column: "user_id" },
  { table: "memory_deletions", column: "user_id" },
  { table: "conversation_deletions", column: "user_id" },
  { table: "memory_references", column: "user_id" },
  { table: "memory_revision_requests", column: "user_id" },
  { table: "memory_candidates", column: "user_id" },
  { table: "messages", column: "user_id" },
  { table: "conversations", column: "user_id" },
  { table: "profiles", column: "id" },
];

/**
 * 台帳を当てる。
 *
 * @param S 当てる先のスキーマ。ふだんは隔離した場所（restore）。
 *          本番を物理バックアップで戻した直後だけ public（scripts/recover-ledger.ts から、ガードを通ってから）。
 * 当てる先・本番かどうかの確認は、呼ぶ側で行う。ここでは確認しない。
 */
export function applyLedgers(S: string): void {
  const all = readAllLedgers();
  const DIR = all.dir;
  // ⓪ 完全に消した利用者の行は、ほかの台帳からも除く（その人の行を入れ直さないため）
  const gone = deletedAccounts(all.accounts);
  const keep = (rows: Record<string, unknown>[]) => rows.filter((r) => !gone.has(String(r.user_id)));
  const revisions = keep(all.revisions);
  const deletions = keep(all.deletions);
  const convDeletions = keep(all.convDeletions);
  const closures = keep(all.closures);

  console.log(`台帳：${DIR}`);
  console.log(`当てる先：${S}`);
  console.log(
    `  完全削除 ${gone.size} 人 ／ 変更 ${revisions.length} 件 ／ 記憶の削除 ${deletions.length} 件 ／ ` +
      `会話の削除 ${convDeletions.length} 件 ／ ［残さない］ ${closures.length} 件\n`,
  );

  // いま戻した場所にある id を調べておく（番号だけ。本文は読まない）
  const present = new Set(runSql<{ id: string }>(`select id from ${S}.memory_candidates`).map((r) => r.id));
  const messages = new Set(runSql<{ id: string }>(`select id from ${S}.messages`).map((r) => r.id));
  const conversations = new Set(runSql<{ id: string }>(`select id from ${S}.conversations`).map((r) => r.id));
  // 元の記憶の会話・発言（付け直しに使う。番号だけ）
  const origin = new Map(
    runSql<{ id: string; conversation_id: string; source_message_id: string }>(
      `select id, conversation_id, source_message_id from ${S}.memory_candidates`,
    ).map((r) => [r.id, r]),
  );

  const sql: string[] = [
    "begin;",
    "set constraints all deferred;",
    "create temp table _restore_counts (ord int, label text, n int);",
  ];

  // =========================================================
  // ⓪ 完全削除（D5）：38日以内に完全に消した利用者を、戻った場所から消し直す
  // =========================================================
  let accountsRemoved = 0;
  for (const userId of gone) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) continue;
    if (S === "public") {
      // 本番を戻した直後：ログイン情報ごと消す（その人の行は、すべての表から連鎖して消える）
      sql.push(`delete from auth.users where id = ${lit(userId)};`);
    }
    // 子の表から順に（連鎖の無い場所・念のため）
    for (const t of USER_TABLES) {
      sql.push(`delete from ${S}.${t.table} where ${t.column} = ${lit(userId)};`);
    }
    accountsRemoved += 1;
  }

  // =========================================================
  // ① 変更（訂正・考えの変化）
  // =========================================================
  let addedRevision = 0;
  let addedDeletedVersion = 0;
  let neutralized = 0;
  let reattached = 0;
  let skipped = 0;

  /* 古い版から順に当てる。
     「直した日時（revised_at）」は、その版がさらに直されたときに書き換わるため、
     それだけで並べると順番が逆になることがある（Phase C で見つかった）。
     版の番号（version）は必ず増えるので、まず版の番号で並べる。 */
  const sortedRevisions = [...revisions].sort(
    (a, b) =>
      Number(a.version ?? 0) - Number(b.version ?? 0) ||
      String(a.revised_at ?? "").localeCompare(String(b.revised_at ?? "")),
  );

  for (const r of sortedRevisions) {
    const id = String(r.id);
    const oldId = r.revision_of == null ? null : String(r.revision_of);
    const kind = String(r.revision_kind);
    const newStatus = kind === "correction" ? "superseded" : "archived";
    // 消した系列の版（本文なし）。版1の台帳の行は「削除済み」の欄を持たないので、本文の有無でも見る
    const isDeleted = r.deleted === true || r.text == null;

    if (!oldId || !present.has(oldId)) {
      // 直す前の記憶が控えに無い＝控えより後に作られて直された。当てるものがない
      skipped += 1;
      continue;
    }

    /* 直したときの会話・発言が控えに無いことがある（控えより後の出来事なので）。
       そのときは、元の記憶と同じ会話・発言に付け直す。 */
    let convId = String(r.conversation_id);
    let msgId = String(r.source_message_id);
    if (!conversations.has(convId) || !messages.has(msgId)) {
      const fallback = origin.get(oldId);
      if (!fallback) {
        skipped += 1;
        continue;
      }
      convId = fallback.conversation_id;
      msgId = fallback.source_message_id;
      reattached += 1;
    }

    if (!present.has(id)) {
      if (isDeleted) {
        // 消した系列の版：本文なしの「削除」で入れる（つながりだけ保つ）
        sql.push(`
          insert into ${S}.memory_candidates (
            id, user_id, conversation_id, source_message_id, candidate_index,
            suggested_text, confirmed_text, extraction_reason, origin, requested_by_user,
            status, confirmed_at, revised_at, deleted_at, version, revision_of, revision_kind
          ) values (
            ${lit(id)}, ${lit(r.user_id)}, ${lit(convId)}, ${lit(msgId)}, ${lit(r.candidate_index ?? 1)},
            null, null, null, ${lit(r.origin ?? "self_experience")}, ${lit(r.requested_by_user ?? true)},
            'deleted', ${lit(r.confirmed_at)}, ${lit(r.revised_at)}, ${lit(r.deleted_at ?? r.revised_at)},
            ${lit(r.version ?? 2)}, ${lit(oldId)}, ${lit(kind)}
          )
          on conflict (id) do nothing;`);
        addedDeletedVersion += 1;
      } else {
        // 控えより後の、消していない訂正：本文ありで入れ直す
        sql.push(`
          insert into ${S}.memory_candidates (
            id, user_id, conversation_id, source_message_id, candidate_index,
            suggested_text, confirmed_text, origin, requested_by_user,
            status, confirmed_at, revised_at, version, revision_of, revision_kind
          ) values (
            ${lit(id)}, ${lit(r.user_id)}, ${lit(convId)}, ${lit(msgId)}, ${lit(r.candidate_index ?? 1)},
            ${lit(r.text)}, ${lit(r.text)}, ${lit(r.origin ?? "self_experience")},
            ${lit(r.requested_by_user ?? true)},
            'confirmed', ${lit(r.confirmed_at)}, ${lit(r.revised_at)},
            ${lit(r.version ?? 2)}, ${lit(oldId)}, ${lit(kind)}
          )
          on conflict (id) do nothing;`);
        addedRevision += 1;
      }
      present.add(id);
      origin.set(id, { id, conversation_id: convId, source_message_id: msgId });
    }

    /* 直す前の記憶を無効にする（＝間違っていた内容が「いま有効」に戻らない）。
       つながり（superseded_by）は、直す前の版が「削除」で入った場合でも付ける
       （消した系列の中の版どうしも、正しく指し合うように）。状態を変えるのは「いま有効」のときだけ。 */
    sql.push(`
      update ${S}.memory_candidates
      set status = case when status = 'confirmed' then ${lit(newStatus)} else status end,
          revised_at = case when status = 'confirmed' then ${lit(r.revised_at)}::timestamptz else revised_at end,
          superseded_by = coalesce(superseded_by, ${lit(id)}::uuid)
      where id = ${lit(oldId)};`);
    sql.push(excludeContextSql(S, oldId, kind === "correction" ? "corrected" : "updated"));
    neutralized += 1;
  }

  // =========================================================
  // ② 記憶の削除
  // =========================================================
  let deletedApplied = 0;
  let deletedAbsent = 0;

  for (const d of deletions) {
    const memoryId = String(d.memory_id);

    // 削除の記録そのものは、戻した場所に記憶が無くても入れ直す（台帳が正、DBが従）
    sql.push(`
      insert into ${S}.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope, deleted_at)
      values (${lit(d.user_id)}, ${lit(memoryId)}, ${lit(d.source_message_id)},
              ${lit(d.conversation_id)}, ${lit(d.scope)}, ${lit(d.deleted_at)})
      on conflict (user_id, memory_id) do nothing;`);

    if (!present.has(memoryId)) {
      deletedAbsent += 1;
      continue;
    }

    // 先に、その記憶に関係する古いやりとりを文脈から外す（本文を消す前に）
    sql.push(excludeContextSql(S, memoryId, "deleted"));

    // 提案の文章の案と理由を消し、確認待ちなら閉じる（C4 ／ 本体の G3 と同じ）
    sql.push(`
      update ${S}.memory_revision_requests
      set proposed_text = null, reason = null,
          status = case when status = 'pending' then 'dismissed' else status end,
          resolved_at = coalesce(resolved_at, ${lit(d.deleted_at)})
      where target_memory_id = ${lit(memoryId)}
        and (proposed_text is not null or reason is not null or status = 'pending');`);

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

    deletedApplied += 1;
  }

  // =========================================================
  // ③ 会話の削除（C2）
  // =========================================================
  let convApplied = 0;
  let convAbsent = 0;

  for (const c of convDeletions) {
    const convId = String(c.conversation_id);

    sql.push(`
      insert into ${S}.conversation_deletions (user_id, conversation_id, deleted_at)
      values (${lit(c.user_id)}, ${lit(convId)}, ${lit(c.deleted_at)})
      on conflict (user_id, conversation_id) do nothing;`);

    if (!conversations.has(convId)) {
      convAbsent += 1;
      continue;
    }

    // その会話の記憶を使った「別の会話の返事」を、AIへ送らない（G1）
    sql.push(`
      update ${S}.messages m
      set excluded_from_ai_at = now(), exclusion_reason = 'deleted'
      where m.excluded_from_ai_at is null
        and m.conversation_id <> ${lit(convId)}
        and m.id in (
          select r.message_id from ${S}.memory_references r
          join ${S}.memory_candidates mc on mc.id = r.memory_id
          where mc.conversation_id = ${lit(convId)}
        );`);

    // その会話の記憶の出典は墓標にする（記憶が消えると番号が外れるので、先に日時を付ける）
    sql.push(`
      update ${S}.memory_references r
      set memory_deleted_at = coalesce(r.memory_deleted_at, ${lit(c.deleted_at)})
      from ${S}.memory_candidates mc
      where mc.id = r.memory_id and mc.conversation_id = ${lit(convId)};`);

    // その会話から作った記憶の削除の記録（本文なし）
    sql.push(`
      insert into ${S}.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope, deleted_at)
      select mc.user_id, mc.id, mc.source_message_id, mc.conversation_id, 'conversation', ${lit(c.deleted_at)}
      from ${S}.memory_candidates mc
      where mc.conversation_id = ${lit(convId)}
      on conflict (user_id, memory_id) do nothing;`);

    /* 会話を消す。その会話の記憶が、別の会話の版のつながりに入っていた場合に備え、
       先に「削除」にしておく（本体の N-1 と同じ。系列の残りは ⑥ でそろえる） */
    sql.push(`
      update ${S}.memory_candidates
      set status = 'deleted', suggested_text = null, confirmed_text = null,
          extraction_reason = null, deleted_at = coalesce(deleted_at, ${lit(c.deleted_at)})
      where conversation_id = ${lit(convId)} and status <> 'deleted';`);
    sql.push(`delete from ${S}.conversations where id = ${lit(convId)};`);

    convApplied += 1;
  }

  // =========================================================
  // ④ ［残さない］（C3）
  // =========================================================
  const closeRows = closures.filter((c) => c.status === "rejected" && present.has(String(c.id)));
  for (const c of closeRows) {
    sql.push(`
      update ${S}.memory_candidates
      set status = 'rejected', suggested_text = null, confirmed_text = null,
          extraction_reason = null, confirmed_at = ${lit(c.decided_at)}
      where id = ${lit(c.id)} and status = 'pending';`);
  }

  // =========================================================
  // ⑤ 期限切れ（C5） ／ ⑥ 仕上げの見直し … 件数を返す形で流す
  // =========================================================
  sql.push(
    counted(
      5,
      "期限切れにした確認待ち",
      `u as (
         update ${S}.memory_candidates
         set status = 'expired', suggested_text = null, confirmed_text = null, extraction_reason = null
         where status = 'pending' and expires_at <= now()
         returning 1)`,
    ),
    counted(
      6,
      "系列の片方だけ残った版を削除にした",
      `seeds as (
         select id, user_id from ${S}.memory_candidates
         where status in ('superseded', 'archived') and superseded_by is null
       ),
       chain as (
         select m.id, m.user_id, m.revision_of, m.superseded_by from ${S}.memory_candidates m
         where m.id in (select id from seeds)
         union
         select m.id, m.user_id, m.revision_of, m.superseded_by from ${S}.memory_candidates m
         join chain c on m.user_id = c.user_id
          and (m.id = c.revision_of or m.id = c.superseded_by or m.revision_of = c.id or m.superseded_by = c.id)
       ),
       rec as (
         insert into ${S}.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
         select m.user_id, m.id, m.source_message_id, m.conversation_id, 'conversation'
         from ${S}.memory_candidates m where m.id in (select id from chain)
         on conflict (user_id, memory_id) do nothing
         returning 1
       ),
       u as (
         update ${S}.memory_candidates
         set status = 'deleted', suggested_text = null, confirmed_text = null,
             extraction_reason = null, deleted_at = now()
         where id in (select id from chain) and status <> 'deleted'
         returning 1)`,
      true,
    ),
    counted(
      7,
      "消えた記憶を使った返事に「AIへ送らない印」を付けた",
      `u as (
         update ${S}.messages msg
         set excluded_from_ai_at = now(), exclusion_reason = 'deleted'
         where msg.excluded_from_ai_at is null
           and msg.id in (
             select r.message_id from ${S}.memory_references r
             left join ${S}.memory_candidates c on c.id = r.memory_id
             where (r.memory_id is null and r.memory_deleted_at is not null) or c.status = 'deleted')
         returning 1)`,
    ),
    counted(
      8,
      "消えた記憶への提案の文章の案・理由を消した",
      `u as (
         update ${S}.memory_revision_requests q
         set proposed_text = null, reason = null,
             status = case when q.status = 'pending' then 'dismissed' else q.status end,
             resolved_at = coalesce(q.resolved_at, now())
         from ${S}.memory_candidates c
         where c.id = q.target_memory_id and c.status = 'deleted'
           and (q.proposed_text is not null or q.reason is not null or q.status = 'pending')
         returning 1)`,
    ),
  );
  sql.push("commit;");
  // 控えた件数を読む（本文は含まない）。一時的な表は、この接続が終わると消える
  sql.push("select label, n from _restore_counts order by ord;");

  const results = runSql<{ label?: string; n?: number }>(sql.join("\n")).filter((r) => r.label);

  // =========================================================
  // 報告（件数だけ）
  // =========================================================
  console.log("⓪ 完全削除");
  console.log(`   消し直した利用者（38日以内の台帳）：${accountsRemoved} 人\n`);
  console.log("① 変更（訂正・考えの変化）");
  console.log(`   古い内容を無効にした　　　　　　：${neutralized} 件`);
  console.log(`   消していない訂正を入れ直した　　：${addedRevision} 件`);
  console.log(`   消した系列の版を本文なしで入れた：${addedDeletedVersion} 件`);
  if (reattached > 0) console.log(`   元の会話へ付け直した　　　　　　：${reattached} 件`);
  if (skipped > 0) console.log(`   控えに直す前の記憶が無く当てず　：${skipped} 件`);

  console.log("\n② 記憶の削除");
  console.log(`   当てた　　　　　　　　　　　　　：${deletedApplied} 件`);
  console.log(`   控えに無く、記録だけ入れた　　　：${deletedAbsent} 件`);

  console.log("\n③ 会話の削除");
  console.log(`   会話を消し直した　　　　　　　　：${convApplied} 件`);
  console.log(`   控えに無く、記録だけ入れた　　　：${convAbsent} 件`);

  console.log("\n④ ［残さない］");
  console.log(`   閉じ直す対象（控えにあったもの）：${closeRows.length} 件`);

  console.log("\n⑤ 期限切れ ／ ⑥ 仕上げの見直し");
  for (const r of results) console.log(`   ${r.label}：${r.n} 件`);

  console.log("\n当て終えました。まだ利用を再開してはいけません。");
}

/** 番号の一覧を SQL の in (...) にする。番号の形でないものは入れない */
function inList(ids: string[]): string {
  const safe = ids.filter((i) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i));
  return safe.length ? safe.map((i) => `'${i}'`).join(",") : "null";
}

/**
 * 台帳を当てたら何件変わるかを数える（何も変えない）。本番復旧の「表示だけ」で使う。
 * 数えるのは件数だけ。本文は読まない。
 */
export function planLedgers(S: string): Record<string, number> {
  const all = readAllLedgers();
  const gone = deletedAccounts(all.accounts);
  const keep = (rows: Record<string, unknown>[]) => rows.filter((r) => !gone.has(String(r.user_id)));
  const revisions = keep(all.revisions);
  const deletionIds = keep(all.deletions).map((r) => String(r.memory_id));
  const convIds = keep(all.convDeletions).map((r) => String(r.conversation_id));
  const closureIds = keep(all.closures).map((r) => String(r.id));
  const revIds = revisions.map((r) => String(r.id));
  const oldIds = revisions.map((r) => String(r.revision_of ?? ""));

  const [row] = runSql<Record<string, number>>(`
    select
      (select count(*) from ${S}.profiles where id in (${inList([...gone])}))::int as accounts,
      ${revIds.length} - (select count(*) from ${S}.memory_candidates where id in (${inList(revIds)}))::int as revisions_missing,
      (select count(*) from ${S}.memory_candidates where id in (${inList(oldIds)}) and status = 'confirmed')::int as revisions_old_still_current,
      (select count(*) from ${S}.memory_candidates where id in (${inList(deletionIds)}) and status <> 'deleted')::int as deletions,
      (select count(*) from ${S}.conversations where id in (${inList(convIds)}))::int as conversations,
      (select count(*) from ${S}.memory_candidates where id in (${inList(closureIds)}) and status = 'pending')::int as closures,
      (select count(*) from ${S}.memory_candidates where status = 'pending' and expires_at <= now())::int as expired`);
  return {
    完全に消した利用者で戻っている人: row?.accounts ?? 0,
    台帳にあるが戻っていない訂正の版: row?.revisions_missing ?? 0,
    直す前なのに有効のままの版: row?.revisions_old_still_current ?? 0,
    消したのに削除になっていない記憶: row?.deletions ?? 0,
    消したのに戻っている会話: row?.conversations ?? 0,
    残さないと決めたのに確認待ちの候補: row?.closures ?? 0,
    期限を過ぎた確認待ち: row?.expired ?? 0,
  };
}

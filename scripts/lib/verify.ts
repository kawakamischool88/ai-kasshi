/**
 * 戻した場所の点検の本体（Phase 4A・Phase C・Phase D）。
 *
 * 呼ぶのは次の2つだけ。
 *   scripts/restore-verify.ts … 隔離した場所（restore）を点検する
 *   scripts/recover-ledger.ts … 本番を物理バックアップで戻し、台帳を当てた直後の public を点検する
 *
 * 【件数が合うだけでは足りない】
 * 誰のものか・どの会話のどの発言から来たか・どの版が有効か・出典がどれを指しているか――
 * id と関係まで照らし合わせる。控えを取ったあとに本人が消した・直した・残さないと決めた内容、
 * 完全に消した利用者が、いま有効な情報として復活していないことを確かめる。
 *
 * 【表示するのは項目名と件数だけ】本文・メールアドレスは表示しない。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEDGERS } from "../../src/config/backup";
import { runSql } from "./db";
import { ledgerDir } from "./paths";
import { countTextInDeleted, readLedgerFile } from "./ledger-file";
import { deletedAccounts, USER_TABLES } from "./ledger-apply";

// ふだんは backups/ledger。テストでは AI_KASSHI_BACKUP_DIR で切り替える（Phase C）
function DIR(): string {
  return ledgerDir();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 台帳の番号を、SQL の in (...) にする。番号の形でないものは入れない */
function inListOf(ids: string[]): string {
  const safe = ids.filter((i) => UUID.test(i));
  return safe.length ? safe.map((i) => `'${i}'`).join(",") : "null";
}

type Check = { name: string; ok: boolean; detail: string };
let checks: Check[] = [];

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
}

/** 件数を1つ取り出す */
function count(sql: string): number {
  const [row] = runSql<{ n: number }>(sql);
  return Number(row?.n ?? 0);
}

/**
 * 点検する。
 * @param S 点検する場所。ふだんは隔離した場所（restore）。本番を戻した直後だけ public。
 * @param opts.production 本番の public を点検するとき true（「API に出ていない」の項目は当てはまらないので省く）
 * @returns すべて異常なしなら true
 */
export function runVerify(S: string, opts: { production?: boolean } = {}): boolean {
  checks = [];
  /* 完全に消した利用者（38日以内の台帳）の行は、ほかの台帳から除いて点検する。
     その人の行は戻した場所に無い（⓪で消した）のが正しいので、「記録が入っている」を求めない */
  const gone = deletedAccounts(readLedgerFile(path.join(DIR(), LEDGERS.accountDeletions.file)));
  const notGone = <T extends { user_id?: unknown }>(rows: T[]) => rows.filter((r) => !gone.has(String(r.user_id)));
  // =========================================================
  // A. 持ち主と、表どうしのつながり
  // =========================================================
  check(
    "会話の持ち主と、その中の発言の持ち主が食い違っていない",
    count(`select count(*)::int as n from ${S}.messages m
           join ${S}.conversations c on c.id = m.conversation_id
           where c.user_id <> m.user_id`) === 0,
  );

  check(
    "記憶の持ち主と、もとの会話・発言の持ち主が食い違っていない",
    count(`select count(*)::int as n from ${S}.memory_candidates mc
           join ${S}.messages m on m.id = mc.source_message_id
           where m.user_id <> mc.user_id`) === 0,
  );

  check(
    "記憶のもとになった発言が、すべて残っている",
    count(`select count(*)::int as n from ${S}.memory_candidates mc
           left join ${S}.messages m on m.id = mc.source_message_id
           where m.id is null`) === 0,
  );

  check(
    "出典が指している返事が、すべて残っている",
    count(`select count(*)::int as n from ${S}.memory_references r
           left join ${S}.messages m on m.id = r.message_id
           where m.id is null`) === 0,
  );

  check(
    "出典の持ち主と、その返事の持ち主が食い違っていない",
    count(`select count(*)::int as n from ${S}.memory_references r
           join ${S}.messages m on m.id = r.message_id
           where m.user_id <> r.user_id`) === 0,
  );

  // =========================================================
  // B. 記憶の版・訂正・考えの変化のつながり
  // =========================================================
  check(
    "「直す前の記憶」の指し先が、すべて残っている",
    count(`select count(*)::int as n from ${S}.memory_candidates mc
           where mc.revision_of is not null
             and not exists (select 1 from ${S}.memory_candidates p where p.id = mc.revision_of)`) === 0,
  );

  check(
    "「直したあとの記憶」の指し先が、すべて残っている",
    count(`select count(*)::int as n from ${S}.memory_candidates mc
           where mc.superseded_by is not null
             and not exists (select 1 from ${S}.memory_candidates p where p.id = mc.superseded_by)`) === 0,
  );

  check(
    "直す前と直したあとが、たがいを正しく指し合っている",
    count(`select count(*)::int as n from ${S}.memory_candidates n
           join ${S}.memory_candidates o on o.id = n.revision_of
           where o.superseded_by is distinct from n.id`) === 0,
  );

  check(
    "訂正・考えの変化には、必ず種類が付いている（削除済みの版は、元の版が消えていてもよい）",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where status <> 'deleted' and (revision_of is null) <> (revision_kind is null)`) === 0,
  );

  check(
    "系列の片方だけ残った版（新しい版が無いのに「訂正前」「以前の考え」のもの）がない",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where status in ('superseded', 'archived') and superseded_by is null`) === 0,
  );

  check(
    "版の数が、直す前より必ず大きい",
    count(`select count(*)::int as n from ${S}.memory_candidates n
           join ${S}.memory_candidates o on o.id = n.revision_of
           where n.version <= o.version`) === 0,
  );

  check(
    "訂正された古い内容が「いま有効」に戻っていない",
    count(`select count(*)::int as n from ${S}.memory_candidates o
           join ${S}.memory_candidates n on n.revision_of = o.id
           where n.revision_kind = 'correction' and o.status = 'confirmed'`) === 0,
  );

  check(
    "考えが変わる前の内容が「いま有効」に戻っていない",
    count(`select count(*)::int as n from ${S}.memory_candidates o
           join ${S}.memory_candidates n on n.revision_of = o.id
           where n.revision_kind = 'update' and o.status = 'confirmed'`) === 0,
  );

  check(
    "訂正された古い内容が「昔の考え」に混ざっていない",
    count(`select count(*)::int as n from ${S}.past_memories p
           join ${S}.memory_candidates n on n.revision_of = p.id
           where n.revision_kind = 'correction'`) === 0,
  );

  // =========================================================
  // C. 削除が当たっているか（いちばん大事）
  // =========================================================
  const ledger = existsSync(path.join(DIR(), LEDGERS.deletions.file))
    ? readFileSync(path.join(DIR(), LEDGERS.deletions.file), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { memory_id: string; user_id?: string })
    : [];
  const ledgerIds = [...new Set(notGone(ledger).map((r) => r.memory_id))];

  if (ledgerIds.length === 0) {
    check("削除台帳", false, "台帳が空です。先に npm run ledger を実行してください");
  } else {
    const inList = ledgerIds.map((id) => `'${id}'`).join(",");

    check(
      "台帳にある記憶が、確定記憶として復活していない",
      count(`select count(*)::int as n from ${S}.confirmed_memories where id in (${inList})`) === 0,
    );

    check(
      "台帳にある記憶が、昔の考えとして復活していない",
      count(`select count(*)::int as n from ${S}.past_memories where id in (${inList})`) === 0,
    );

    check(
      "台帳にある記憶の本文が、どこにも残っていない",
      count(`select count(*)::int as n from ${S}.memory_candidates
             where id in (${inList})
               and (suggested_text is not null or confirmed_text is not null
                    or extraction_reason is not null)`) === 0,
    );

    check(
      "台帳にある記憶は、すべて「削除済み」になっている",
      count(`select count(*)::int as n from ${S}.memory_candidates
             where id in (${inList}) and status <> 'deleted'`) === 0,
    );

    check(
      "消した記憶が、操作の提案として残っていない",
      count(`select count(*)::int as n from ${S}.memory_revision_requests
             where target_memory_id in (${inList}) and status = 'pending'`) === 0,
    );

    check(
      "消した記憶の出典に、墓標（消えた日時）が付いている",
      count(`select count(*)::int as n from ${S}.memory_references
             where memory_id in (${inList}) and memory_deleted_at is null`) === 0,
    );

    check(
      "消した記憶のもとになった発言が、AIへ送られない印になっている",
      count(`select count(*)::int as n from ${S}.memory_candidates mc
             join ${S}.messages m on m.id = mc.source_message_id
             where mc.id in (${inList}) and m.excluded_from_ai_at is null`) === 0,
    );

    check(
      "削除の記録が、戻した場所にも入っている",
      count(`select count(*)::int as n from ${S}.memory_deletions where memory_id in (${inList})`) >=
        ledgerIds.length,
    );
  }

  // =========================================================
  // D. 消した本文が、どこにも残っていないか（横断）
  // =========================================================
  check(
    "「削除済み」の記憶で、本文を持っているものがない",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where status = 'deleted'
             and (suggested_text is not null or confirmed_text is not null
                  or extraction_reason is not null)`) === 0,
  );

  check(
    "「残さない」「期限切れ」の候補で、本文を持っているものがない",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where status in ('rejected','expired')
             and (suggested_text is not null or confirmed_text is not null
                  or extraction_reason is not null)`) === 0,
  );

  check(
    "削除の記録に、本文らしい列がない",
    runSql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = '${S}' and table_name = 'memory_deletions'`,
    ).every((c) => !/text|content|body|suggested|reason|title/i.test(c.column_name)),
  );

  // =========================================================
  // G. Phase C：本人の判断が、戻した場所でも守られているか
  // =========================================================
  check(
    "削除済みの記憶への提案に、AIの文章の案・理由が残っていない",
    count(`select count(*)::int as n from ${S}.memory_revision_requests q
           join ${S}.memory_candidates c on c.id = q.target_memory_id
           where c.status = 'deleted' and (q.proposed_text is not null or q.reason is not null)`) === 0,
  );

  check(
    "削除済みの記憶への提案が、確認待ちのまま残っていない",
    count(`select count(*)::int as n from ${S}.memory_revision_requests q
           join ${S}.memory_candidates c on c.id = q.target_memory_id
           where c.status = 'deleted' and q.status = 'pending'`) === 0,
  );

  check(
    "消えた記憶を使った返事が、AIへ送られない印になっている",
    count(`select count(*)::int as n from ${S}.messages m
           where m.excluded_from_ai_at is null
             and m.id in (
               select r.message_id from ${S}.memory_references r
               left join ${S}.memory_candidates c on c.id = r.memory_id
               where (r.memory_id is null and r.memory_deleted_at is not null) or c.status = 'deleted')`) === 0,
  );

  const convLedger = notGone(readLedgerFile(path.join(DIR(), LEDGERS.conversationDeletions.file)));
  const convIds = [...new Set(convLedger.map((r) => String(r.conversation_id)))];
  check(
    "会話の削除の台帳にある会話が、戻した場所に残っていない",
    count(`select count(*)::int as n from ${S}.conversations where id in (${inListOf(convIds)})`) === 0,
    `台帳の件数：${convIds.length}`,
  );
  check(
    "会話の削除の台帳にある会話の発言が、戻した場所に残っていない",
    count(`select count(*)::int as n from ${S}.messages where conversation_id in (${inListOf(convIds)})`) === 0,
  );
  check(
    "会話の削除の記録が、戻した場所にも入っている",
    count(`select count(distinct conversation_id)::int as n from ${S}.conversation_deletions
           where conversation_id in (${inListOf(convIds)})`) === convIds.length,
  );

  const closureLedger = notGone(readLedgerFile(path.join(DIR(), LEDGERS.closures.file)));
  const closureIds = [...new Set(closureLedger.map((r) => String(r.id)))];
  check(
    "［残さない］の台帳にある候補が、本文なしの「残さない」になっている",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where id in (${inListOf(closureIds)})
             and status <> 'deleted'
             and (status <> 'rejected' or suggested_text is not null or confirmed_text is not null
                  or extraction_reason is not null)`) === 0,
    `台帳の件数：${closureIds.length}`,
  );

  check(
    "期限を過ぎた「確認待ち」が残っていない",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where status = 'pending' and expires_at <= now()`) === 0,
  );

  {
    const deletedMap = new Map<string, string | null>();
    for (const r of readLedgerFile(path.join(DIR(), LEDGERS.deletions.file))) {
      deletedMap.set(String(r.memory_id), (r.deleted_at as string | null) ?? null);
    }
    const left = countTextInDeleted(readLedgerFile(path.join(DIR(), LEDGERS.revisions.file)), deletedMap);
    check("変更台帳で、消した系列の行に本文が残っていない", left === 0, left ? `残っている行：${left}` : "");
  }

  // =========================================================
  // E. 他人のデータと、RLS
  // =========================================================
  check(
    "どの表にも、持ち主のいない行がない",
    count(`select
             (select count(*) from ${S}.conversations where user_id is null)
           + (select count(*) from ${S}.messages where user_id is null)
           + (select count(*) from ${S}.memory_candidates where user_id is null)
           + (select count(*) from ${S}.memory_references where user_id is null)
           + (select count(*) from ${S}.memory_deletions where user_id is null)
           + (select count(*) from ${S}.ai_usage where user_id is null) as n`) === 0,
  );

  const rlsOff = runSql<{ tablename: string }>(
    `select c.relname as tablename from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = '${S}' and c.relkind = 'r' and c.relrowsecurity = false`,
  );
  check(
    "戻した場所のすべての表で、RLS が入になっている",
    rlsOff.length === 0,
    rlsOff.length ? `入っていない表：${rlsOff.map((r) => r.tablename).join(", ")}` : "",
  );

  const policyDiff = runSql<{ tablename: string; policyname: string; side: string }>(
    `select tablename, policyname, 'public にだけある' as side
       from pg_policies where schemaname = 'public'
     except all
     select tablename, policyname, 'public にだけある'
       from pg_policies where schemaname = '${S}'
     union all
     select tablename, policyname, '${S} にだけある'
       from pg_policies where schemaname = '${S}'
     except all
     select tablename, policyname, '${S} にだけある'
       from pg_policies where schemaname = 'public'`,
  );
  check(
    "RLS の決まりが、いま動いている場所とそっくり同じ",
    policyDiff.length === 0,
    policyDiff.length ? policyDiff.map((p) => `${p.tablename}.${p.policyname}（${p.side}）`).join(", ") : "",
  );

  if (!opts.production) {
    check(
      "戻した場所は、アプリのAPIに公開されていない",
      !readFileSync(path.resolve("supabase", "config.toml"), "utf8").includes(`"${S}"`),
    );
  }

  // =========================================================
  // H. Phase D：完全に消した利用者が、戻っていないか
  // =========================================================
  {
    const goneIds = [...gone].filter((id) => UUID.test(id));
    const list = inListOf(goneIds);
    const parts = USER_TABLES.map(
      (t) => `(select count(*) from ${S}.${t.table} where ${t.column} in (${list}))`,
    );
    if (opts.production) parts.push(`(select count(*) from auth.users where id in (${list}))`);
    const left = count(`select (${parts.join(" + ")})::int as n`);
    check(
      "完全に消した利用者（38日以内の台帳）の行が、どの表にも残っていない",
      left === 0,
      `台帳の人数：${goneIds.length}${left ? `／残っている行：${left}` : ""}`,
    );
  }

  // 本当に他人のデータが読めないかを、その場で試す
  const owners = runSql<{ user_id: string; n: number }>(
    `select user_id, count(*)::int as n from ${S}.memory_candidates group by user_id order by n desc`,
  );
  if (owners.length >= 2) {
    const me = owners[0].user_id;
    const crossed = runSql<{ n: number }>(`
      begin;
      set local role authenticated;
      set local request.jwt.claims = '{"sub":"${me}","role":"authenticated"}';
      select count(*)::int as n from ${S}.memory_candidates where user_id <> '${me}';
      rollback;`);
    check(
      "本人としてつないでも、他人の記憶は1件も読めない",
      Number(crossed.at(-1)?.n ?? -1) === 0,
      `他人の記憶が読めた件数：${crossed.at(-1)?.n ?? "確認できず"}`,
    );
  } else {
    check("他人の記憶が読めないか", true, "戻した中に利用者が1人しかいないため、この確認は省略");
  }

  // =========================================================
  // F. 有料のAI処理が走っていないか
  // =========================================================
  /* 戻した日時（restore が場所に書いた印）より後に、成功した呼び出しの記録が増えていないか。
     印が無い（以前の restore で戻した）ときは、これまでどおり「直近10分」で数える。 */
  const [info] = runSql<{ d: string | null }>(
    `select obj_description(to_regnamespace('${S}'), 'pg_namespace') as d`,
  );
  const restoredAt = /^restored_at=(.+)$/.exec(info?.d ?? "")?.[1] ?? null;
  const since = restoredAt
    ? `timestamptz '${restoredAt.replace(/'/g, "")}'`
    : "now() - interval '10 minutes'";
  const recentUsage = count(
    `select count(*)::int as n from ${S}.ai_usage
     where created_at > ${since} and status = 'success'`,
  );
  check(
    "戻した場所で、有料のAI処理が新しく走っていない",
    recentUsage === 0,
    recentUsage
      ? `${restoredAt ? "戻したあと" : "直近10分"}の成功した呼び出し：${recentUsage} 件`
      : restoredAt
        ? "戻した日時より後で数えた"
        : "",
  );

  // =========================================================
  // 結果
  // =========================================================
  console.log("");
  for (const c of checks) {
    console.log(`  ${c.ok ? "○" : "×"} ${c.name}${c.detail ? `　… ${c.detail}` : ""}`);
  }

  const ng = checks.filter((c) => !c.ok);
  console.log("");
  if (ng.length === 0) {
    console.log(`すべて異常なし（${checks.length} 項目）。`);
    console.log("復旧の観点では利用再開できる状態です。");
    console.log("実際に再開するときは、AI_KASSHI_MODE=restore を外してください。");
    return true;
  }
  console.log(`異常 ${ng.length} 件 / ${checks.length} 項目。**利用を再開してはいけません。**`);
  return false;
}

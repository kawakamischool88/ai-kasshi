/**
 * 戻した場所を調べる（Phase 4A）。
 *
 * 実行： npm run restore:verify
 *
 * 【件数が合うだけでは足りない】
 * 誰のものか・どの会話のどの発言から来たか・どの版が有効か・
 * 出典がどれを指しているか――**id と関係まで**照らし合わせる。
 *
 * 【いちばん大事なこと】
 * 控えを取ったあとに本人が消した・直した内容が、
 * **いま有効な情報として復活していないこと**。
 *
 * すべて「異常なし」になるまで、利用を再開してはいけない。
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEDGERS, RESTORE_SCHEMA as S } from "../src/config/backup";
import { runSql } from "./lib/db";

loadEnv({ path: ".env.test.local", override: true });

const DIR = path.resolve("backups", "ledger");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
}

/** 件数を1つ取り出す */
function count(sql: string): number {
  const [row] = runSql<{ n: number }>(sql);
  return Number(row?.n ?? 0);
}

function main() {
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
    "訂正・考えの変化には、必ず種類が付いている",
    count(`select count(*)::int as n from ${S}.memory_candidates
           where (revision_of is null) <> (revision_kind is null)`) === 0,
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
  const ledger = existsSync(path.join(DIR, LEDGERS.deletions.file))
    ? readFileSync(path.join(DIR, LEDGERS.deletions.file), "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { memory_id: string })
    : [];
  const ledgerIds = [...new Set(ledger.map((r) => r.memory_id))];

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
             and (suggested_text is not null or confirmed_text is not null)`) === 0,
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

  check(
    "戻した場所は、アプリのAPIに公開されていない",
    !readFileSync(path.resolve("supabase", "config.toml"), "utf8").includes(`"${S}"`),
  );

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
  const recentUsage = count(
    `select count(*)::int as n from ${S}.ai_usage
     where created_at > now() - interval '10 minutes' and status = 'success'`,
  );
  check(
    "戻した場所で、有料のAI処理が新しく走っていない",
    recentUsage === 0,
    recentUsage ? `直近10分の成功した呼び出し：${recentUsage} 件` : "",
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
  } else {
    console.log(`異常 ${ng.length} 件 / ${checks.length} 項目。**利用を再開してはいけません。**`);
    process.exit(1);
  }
}

main();

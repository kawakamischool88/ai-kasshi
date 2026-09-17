/**
 * 隔離した場所へ、バックアップを戻す（Phase 4A）。
 *
 * 実行： npm run restore -- <バックアップのフォルダ>
 * 例：   npm run restore -- backups/2026-09-22T01-23-45-678Z
 *
 * 【いま動いている場所は、絶対に触らない】
 * 戻すのは `restore` という別の場所（スキーマ）。
 * そこはアプリのAPIから見えないので、**利用者もアプリも触れない**。
 * いま動いている `public` のデータには一切手を触れない。
 *
 * 【戻しただけでは使わない】
 * このあと、
 *   npm run restore:ledger   … そのあと本人が消した・直した事実を当て直す
 *   npm run restore:verify   … 関係が壊れていないか、消したものが残っていないか調べる
 * を行い、すべて問題なしになるまで利用を再開しない。
 *
 * 【本当の災害のとき】
 * 新しい Supabase を作り、migration を流してから、同じ手順でデータを流し込む。
 * 目録（manifest.json）に、どの版の migration まで当てた控えかが書いてある。
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BACKUP_TABLES, RESTORE_SCHEMA } from "../src/config/backup";
import { runSql, ident } from "./lib/db";

loadEnv({ path: ".env.test.local", override: true });

/** 1回の INSERT にまとめる件数 */
const CHUNK = 200;

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使い方： npm run restore -- backups/<フォルダ名>");
    process.exit(1);
  }
  const base = path.resolve(dir);
  const manifestPath = path.join(base, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`目録が見つかりません：${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    createdAt: string;
    migrations: string[];
    tables: Record<string, number>;
  };

  console.log(`控えを取った日時：${manifest.createdAt}`);
  console.log(`控えのDBの版　　：${manifest.migrations.at(-1) ?? "（不明）"}`);
  console.log(`戻す先　　　　　：${RESTORE_SCHEMA} スキーマ（隔離した場所）\n`);

  // いま動いている場所の版と、控えの版が合っているか
  const now = runSql<{ version: string }>(
    "select version from supabase_migrations.schema_migrations order by version",
  ).map((r) => r.version);
  const nowLast = now.at(-1);
  const backupLast = manifest.migrations.at(-1);
  if (nowLast !== backupLast) {
    console.warn(
      `注意：控えの版（${backupLast}）と、いまのDBの版（${nowLast}）が違います。` +
        "\n　　　本当の復旧では、控えと同じ版まで migration を流してから戻してください。\n",
    );
  }

  console.log("① 隔離した場所を作り直します…");
  runSql(buildSchemaSql());

  console.log("② データを流し込みます…");
  const statements: string[] = ["begin;", "set constraints all deferred;"];
  const counts: Record<string, number> = {};

  for (const table of BACKUP_TABLES) {
    const file = path.join(base, `${table}.jsonl`);
    const lines = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
      : [];
    counts[table] = lines.length;

    for (let i = 0; i < lines.length; i += CHUNK) {
      const json = `[${lines.slice(i, i + CHUNK).join(",")}]`;
      statements.push(
        `insert into ${RESTORE_SCHEMA}.${ident(table)}
         select * from jsonb_populate_recordset(
           null::${RESTORE_SCHEMA}.${ident(table)},
           ${quote(json)}::jsonb
         );`,
      );
    }
  }
  statements.push("commit;");
  runSql(statements.join("\n"));

  console.log("③ 件数を確かめます…");
  let ok = true;
  for (const table of BACKUP_TABLES) {
    const [row] = runSql<{ n: number }>(
      `select count(*)::int as n from ${RESTORE_SCHEMA}.${ident(table)}`,
    );
    const got = row?.n ?? 0;
    const want = counts[table];
    const mark = got === want ? "○" : "×";
    if (got !== want) ok = false;
    console.log(`  ${mark} ${table.padEnd(26)} ${String(got).padStart(6)} / ${want} 件`);
  }

  if (!ok) {
    console.error("\n中止：件数が合いません。");
    process.exit(1);
  }

  console.log("\n戻しました。まだ利用を再開してはいけません。");
  console.log("  次： npm run restore:ledger   （消した・直した事実を当て直す）");
  console.log("  次： npm run restore:verify   （関係と安全を調べる）");
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 隔離した場所の形を作る。
 *
 * いま動いている場所の形をそのまま写す（列・初期値・決まり・索引）。
 * 外部キーと RLS の決まりは、写したあとに付け直す。
 *
 * 【本当の復旧では】
 * 新しい Supabase に migration を流して形を作る。
 * ここで形を写しているのは、**同じ1つのDBの中に隔離した場所を作るため**。
 */
function buildSchemaSql(): string {
  const parts: string[] = [
    `drop schema if exists ${RESTORE_SCHEMA} cascade;`,
    `create schema ${RESTORE_SCHEMA};`,
  ];

  // 表の形をそのまま写す
  for (const table of BACKUP_TABLES) {
    parts.push(
      `create table ${RESTORE_SCHEMA}.${ident(table)} (like public.${ident(table)} including all);`,
    );
  }

  /* 表どうしのつながり（外部キー）を付け直す。
     LIKE では写らないため、ここで明示する。
     記憶どうしのつながり（訂正前・訂正後）は、
     流し込む順番の都合で「あとでまとめて確かめる」形にする。 */
  parts.push(`
    alter table ${RESTORE_SCHEMA}.conversations
      add constraint conversations_user_fk foreign key (user_id) references auth.users (id) on delete cascade;

    alter table ${RESTORE_SCHEMA}.messages
      add constraint messages_conversation_fk foreign key (conversation_id) references ${RESTORE_SCHEMA}.conversations (id) on delete cascade,
      add constraint messages_user_fk foreign key (user_id) references auth.users (id) on delete cascade;

    alter table ${RESTORE_SCHEMA}.memory_candidates
      add constraint mc_user_fk foreign key (user_id) references auth.users (id) on delete cascade,
      add constraint mc_conversation_fk foreign key (conversation_id) references ${RESTORE_SCHEMA}.conversations (id) on delete cascade,
      add constraint mc_source_fk foreign key (source_message_id) references ${RESTORE_SCHEMA}.messages (id) on delete cascade,
      add constraint mc_revision_of_fk foreign key (revision_of) references ${RESTORE_SCHEMA}.memory_candidates (id) on delete set null deferrable initially deferred,
      add constraint mc_superseded_by_fk foreign key (superseded_by) references ${RESTORE_SCHEMA}.memory_candidates (id) on delete set null deferrable initially deferred;

    alter table ${RESTORE_SCHEMA}.memory_references
      add constraint mr_user_fk foreign key (user_id) references auth.users (id) on delete cascade,
      add constraint mr_message_fk foreign key (message_id) references ${RESTORE_SCHEMA}.messages (id) on delete cascade,
      add constraint mr_memory_fk foreign key (memory_id) references ${RESTORE_SCHEMA}.memory_candidates (id) on delete set null;

    alter table ${RESTORE_SCHEMA}.memory_revision_requests
      add constraint mrr_user_fk foreign key (user_id) references auth.users (id) on delete cascade,
      add constraint mrr_conversation_fk foreign key (conversation_id) references ${RESTORE_SCHEMA}.conversations (id) on delete cascade,
      add constraint mrr_source_fk foreign key (source_message_id) references ${RESTORE_SCHEMA}.messages (id) on delete cascade,
      add constraint mrr_target_fk foreign key (target_memory_id) references ${RESTORE_SCHEMA}.memory_candidates (id) on delete cascade;

    alter table ${RESTORE_SCHEMA}.memory_deletions
      add constraint md_user_fk foreign key (user_id) references auth.users (id) on delete cascade;

    alter table ${RESTORE_SCHEMA}.ai_usage
      add constraint au_user_fk foreign key (user_id) references auth.users (id) on delete cascade,
      add constraint au_conversation_fk foreign key (conversation_id) references ${RESTORE_SCHEMA}.conversations (id) on delete set null,
      add constraint au_message_fk foreign key (message_id) references ${RESTORE_SCHEMA}.messages (id) on delete set null;
  `);

  // 確定記憶・昔の考えの見え方も作る（調べるときに要る）
  parts.push(`
    create view ${RESTORE_SCHEMA}.confirmed_memories with (security_invoker = true) as
      select id, user_id, conversation_id, source_message_id,
             coalesce(confirmed_text, suggested_text) as text,
             origin, requested_by_user, created_at, confirmed_at, version
      from ${RESTORE_SCHEMA}.memory_candidates where status = 'confirmed';

    create view ${RESTORE_SCHEMA}.past_memories with (security_invoker = true) as
      select id, user_id, conversation_id, source_message_id,
             coalesce(confirmed_text, suggested_text) as text,
             origin, version, revised_at, superseded_by, created_at, confirmed_at
      from ${RESTORE_SCHEMA}.memory_candidates where status = 'archived';
  `);

  /* RLS（他人のデータを読めない決まり）を、そっくり写す。
     いま動いている場所の決まりを読み取って、同じものを作る。
     「同じ決まりが付いている」ことを、あとで見比べて確かめられる。 */
  parts.push(`
    do $do$
    declare p record;
    begin
      for p in
        select tablename, policyname, permissive, roles, cmd, qual, with_check
        from pg_policies where schemaname = 'public'
      loop
        execute format('alter table %I.%I enable row level security', ${quote(RESTORE_SCHEMA)}, p.tablename);
        execute format(
          'create policy %I on %I.%I as %s for %s to %s %s %s',
          p.policyname, ${quote(RESTORE_SCHEMA)}, p.tablename,
          p.permissive, p.cmd, array_to_string(p.roles, ','),
          case when p.qual is null then '' else 'using (' || p.qual || ')' end,
          case when p.with_check is null then '' else 'with check (' || p.with_check || ')' end
        );
      end loop;
    end
    $do$;
  `);

  // 権限も同じに（この場所はAPIに公開していないので、外からは触れない）
  parts.push(`
    do $do$
    declare g record;
    begin
      for g in
        select table_name, grantee, string_agg(distinct privilege_type, ', ') as privs
        from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('authenticated', 'anon', 'service_role')
        group by table_name, grantee
      loop
        execute format('grant %s on %I.%I to %I', g.privs, ${quote(RESTORE_SCHEMA)}, g.table_name, g.grantee);
      end loop;
      execute format('grant usage on schema %I to authenticated, service_role', ${quote(RESTORE_SCHEMA)});
    end
    $do$;
  `);

  return parts.join("\n");
}

main();

/**
 * 書き出したファイルを、隔離した場所へ読み込んで照合する（Phase 4B・開発確認用）。
 *
 * 実行： npm run export:check -- <書き出したZIPの場所>
 *
 * 【これは何のためか】
 * 「ZIPが作れた」だけでは合格にしない。
 * **別の場所へ持っていっても、関係が組み直せるか**を確かめる。
 *   会話 → 発言 → 記憶 → 出典、記憶の版のつながり、由来、削除の跡。
 *
 * 【本人の画面に取り込み機能は作らない】
 * これは開発と受け入れ確認のための道具。
 *
 * 【壊れたファイルは、黙って一部だけ取り込まない】
 * 版が分からない・ファイルが足りない・中身が壊れている・関係が合わない、
 * のどれかなら、**途中で止めてエラーにする**。
 */
import { config as loadEnv } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import JSZip from "jszip";
import { EXPORT_FILES, EXPORT_FORMAT_VERSION, REQUIRED_FILES } from "../src/config/export";
import { runSql, lit } from "./lib/db";
import { stopIfNotDev } from "./lib/target";

loadEnv({ path: ".env.test.local", override: true });

/** 読み込む先。いま動いている場所（public）とは別の、APIに公開していない場所 */
const S = "export_check";

type Row = Record<string, unknown>;
type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

async function main() {
  /* 開発用（ai-kasshi-dev）を向いていなければ、その場で止める。
     この命令は export_check スキーマを作り直す（＝いったん消す）ので、本番のDBに対して走らせてはいけない。 */
  stopIfNotDev("cli", "npm run export:check");

  const file = process.argv[2];
  if (!file || !existsSync(file)) {
    console.error("使い方： npm run export:check -- <書き出したZIPの場所>");
    process.exit(1);
  }

  // =========================================================
  // ① ファイルを開き、壊れていないか調べる
  // =========================================================
  const zip = await JSZip.loadAsync(readFileSync(file));

  for (const name of REQUIRED_FILES) {
    if (!zip.file(name)) {
      console.error(`中止：必要なファイルがありません → ${name}`);
      process.exit(1);
    }
  }

  const read = async (name: string): Promise<unknown> => {
    const text = await zip.file(name)!.async("string");
    try {
      return JSON.parse(text);
    } catch {
      console.error(`中止：ファイルの中身が壊れています → ${name}`);
      process.exit(1);
    }
  };

  const manifest = (await read(EXPORT_FILES.manifest)) as {
    formatVersion?: number;
    ownerUserId?: string;
    counts?: Record<string, number>;
  };

  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    console.error(
      `中止：書き出しの形の版が分かりません（見つかった版：${manifest.formatVersion ?? "なし"} ／ 読める版：${EXPORT_FORMAT_VERSION}）`,
    );
    process.exit(1);
  }
  if (!manifest.ownerUserId) {
    console.error("中止：持ち主が書かれていません。");
    process.exit(1);
  }

  const owner = manifest.ownerUserId;
  const conversations = (await read(EXPORT_FILES.conversations)) as Row[];
  const messages = (await read(EXPORT_FILES.messages)) as Row[];
  const memories = (await read(EXPORT_FILES.memories)) as Row[];
  const references = (await read(EXPORT_FILES.references)) as Row[];

  console.log(`書き出しの版　：${manifest.formatVersion}`);
  console.log(`持ち主　　　　：${owner}`);
  console.log(
    `中身　　　　　：会話 ${conversations.length} ／ 発言 ${messages.length} ／ 記憶 ${memories.length} ／ 出典 ${references.length}\n`,
  );

  // =========================================================
  // ② 関係が合っているか（DBへ入れる前に調べる）
  // =========================================================
  const convIds = new Set(conversations.map((c) => String(c.id)));
  const msgIds = new Set(messages.map((m) => String(m.id)));
  const memIds = new Set(memories.map((m) => String(m.id)));

  const broken: string[] = [];
  for (const m of messages) {
    if (!convIds.has(String(m.conversationId))) broken.push(`発言 ${m.id} の会話が無い`);
  }
  for (const m of memories) {
    if (!convIds.has(String(m.conversationId))) broken.push(`記憶 ${m.id} の会話が無い`);
    if (!msgIds.has(String(m.sourceMessageId))) broken.push(`記憶 ${m.id} のもとの発言が無い`);
    if (m.revisionOf && !memIds.has(String(m.revisionOf))) broken.push(`記憶 ${m.id} の前の版が無い`);
    if (m.supersededBy && !memIds.has(String(m.supersededBy)))
      broken.push(`記憶 ${m.id} の次の版が無い`);
  }
  for (const r of references) {
    if (!msgIds.has(String(r.messageId))) broken.push(`出典 ${r.id} の返事が無い`);
    if (r.memoryId && !memIds.has(String(r.memoryId))) broken.push(`出典 ${r.id} の記憶が無い`);
  }

  if (broken.length > 0) {
    console.error("中止：つながりが合いません。一部だけ取り込むことはしません。");
    for (const b of broken.slice(0, 10)) console.error(`  × ${b}`);
    process.exit(1);
  }
  console.log("つながりの確認：異常なし（DBへ入れる前の点検）\n");

  // =========================================================
  // ③ 隔離した場所へ入れる
  // =========================================================
  console.log("隔離した場所へ読み込みます…");
  runSql(buildSchemaSql());

  const sql: string[] = ["begin;", "set constraints all deferred;"];

  for (const c of conversations) {
    sql.push(`insert into ${S}.conversations (id, user_id, title, created_at, last_message_at)
      values (${lit(c.id)}, ${lit(owner)}, ${lit(c.title ?? "")}, ${lit(c.createdAt)}, ${lit(c.lastMessageAt)});`);
  }
  for (const m of messages) {
    sql.push(`insert into ${S}.messages
      (id, conversation_id, user_id, role, content, created_at, excluded_from_ai_at, exclusion_reason)
      values (${lit(m.id)}, ${lit(m.conversationId)}, ${lit(owner)}, ${lit(m.role)},
              ${lit(m.content)}, ${lit(m.createdAt)}, ${lit(m.excludedFromAiAt)}, ${lit(m.exclusionReason)});`);
  }
  for (const m of memories) {
    sql.push(`insert into ${S}.memory_candidates
      (id, user_id, conversation_id, source_message_id, candidate_index,
       suggested_text, confirmed_text, origin, requested_by_user, status,
       created_at, confirmed_at, expires_at,
       revision_of, revision_kind, superseded_by, version, revised_at, deleted_at)
      values (${lit(m.id)}, ${lit(owner)}, ${lit(m.conversationId)}, ${lit(m.sourceMessageId)},
              ${lit(m.candidateIndex)}, ${lit(m.aiSuggestedText)}, ${lit(m.confirmedText)},
              ${lit(m.origin)}, ${lit(m.requestedByUser)}, ${lit(m.status)},
              ${lit(m.createdAt)}, ${lit(m.confirmedAt)}, ${lit(m.expiresAt)},
              ${lit(m.revisionOf)}, ${lit(m.revisionKind)}, ${lit(m.supersededBy)},
              ${lit(m.version)}, ${lit(m.revisedAt)}, ${lit(m.deletedAt)});`);
  }
  for (const r of references) {
    sql.push(`insert into ${S}.memory_references
      (id, user_id, message_id, memory_id, memory_deleted_at, created_at)
      values (${lit(r.id)}, ${lit(owner)}, ${lit(r.messageId)}, ${lit(r.memoryId)},
              ${lit(r.memoryDeletedAt)}, ${lit(r.createdAt)});`);
  }
  sql.push("commit;");
  runSql(sql.join("\n"));

  // =========================================================
  // ④ 入れたあと、件数と関係を照らし合わせる
  // =========================================================
  const one = (q: string): number => Number(runSql<{ n: number }>(q)[0]?.n ?? -1);

  check("会話の件数が合う", one(`select count(*)::int as n from ${S}.conversations`) === conversations.length);
  check("発言の件数が合う", one(`select count(*)::int as n from ${S}.messages`) === messages.length);
  check("記憶の件数が合う", one(`select count(*)::int as n from ${S}.memory_candidates`) === memories.length);
  check("出典の件数が合う", one(`select count(*)::int as n from ${S}.memory_references`) === references.length);

  const want = (s: string) => memories.filter((m) => m.status === s).length;
  check(
    "いまの記憶の件数が合う",
    one(`select count(*)::int as n from ${S}.confirmed_memories`) === want("confirmed"),
    `${one(`select count(*)::int as n from ${S}.confirmed_memories`)} / ${want("confirmed")}`,
  );
  check(
    "昔の考えの件数が合う",
    one(`select count(*)::int as n from ${S}.past_memories`) === want("archived"),
  );
  check(
    "確認待ちの件数が合う",
    one(`select count(*)::int as n from ${S}.memory_candidates where status = 'pending'`) ===
      want("pending"),
  );

  // --- id と関係まで照らし合わせる（件数だけでは足りない） ---
  const mismatch = (q: string) => one(q) === 0;

  check(
    "会話と発言のつながりが、すべて一致する",
    mismatch(`select count(*)::int as n from ${S}.messages m
              left join ${S}.conversations c on c.id = m.conversation_id where c.id is null`),
  );
  check(
    "記憶と、もとの発言のつながりが、すべて一致する",
    mismatch(`select count(*)::int as n from ${S}.memory_candidates mc
              left join ${S}.messages m on m.id = mc.source_message_id where m.id is null`),
  );
  check(
    "記憶の版のつながり（前の版・次の版）が、すべて一致する",
    mismatch(`select count(*)::int as n from ${S}.memory_candidates mc
              where (mc.revision_of is not null
                     and not exists (select 1 from ${S}.memory_candidates p where p.id = mc.revision_of))
                 or (mc.superseded_by is not null
                     and not exists (select 1 from ${S}.memory_candidates p where p.id = mc.superseded_by))`),
  );
  check(
    "訂正・考えの変化が、たがいを正しく指し合っている",
    mismatch(`select count(*)::int as n from ${S}.memory_candidates n
              join ${S}.memory_candidates o on o.id = n.revision_of
              where o.superseded_by is distinct from n.id`),
  );
  check(
    "出典が指している返事が、すべて残っている",
    mismatch(`select count(*)::int as n from ${S}.memory_references r
              left join ${S}.messages m on m.id = r.message_id where m.id is null`),
  );

  // --- 1件ずつ、元のファイルと中身を突き合わせる ---
  const dbMem = runSql<Row>(
    `select id, status, version, origin, revision_of, revision_kind, superseded_by,
            source_message_id, confirmed_at, suggested_text, confirmed_text
     from ${S}.memory_candidates`,
  );
  const byId = new Map(dbMem.map((r) => [String(r.id), r]));

  let sameAll = true;
  const diffs: string[] = [];
  for (const m of memories) {
    const r = byId.get(String(m.id));
    if (!r) {
      sameAll = false;
      diffs.push(`記憶 ${m.id} が無い`);
      continue;
    }
    const same =
      String(r.status) === String(m.status) &&
      Number(r.version) === Number(m.version) &&
      String(r.origin) === String(m.origin) &&
      String(r.revision_of ?? "") === String(m.revisionOf ?? "") &&
      String(r.revision_kind ?? "") === String(m.revisionKind ?? "") &&
      String(r.superseded_by ?? "") === String(m.supersededBy ?? "") &&
      String(r.source_message_id) === String(m.sourceMessageId) &&
      String(r.suggested_text ?? "") === String(m.aiSuggestedText ?? "") &&
      String(r.confirmed_text ?? "") === String(m.confirmedText ?? "");
    if (!same) {
      sameAll = false;
      diffs.push(`記憶 ${m.id} の中身が違う`);
    }
  }
  check(
    "記憶1件ずつの、状態・版・由来・つながり・本文がすべて一致する",
    sameAll,
    diffs.slice(0, 3).join(" / "),
  );

  // --- 由来と、本人が直した文章 ---
  const edited = memories.filter((m) => m.editedByOwner);
  check(
    "本人が直した記憶で、AIの案と本人の文章を区別できる",
    edited.every((m) => m.aiSuggestedText && m.confirmedText && m.aiSuggestedText !== m.confirmedText),
    `本人が直した記憶：${edited.length} 件`,
  );
  check(
    "由来（origin）が、すべての記憶に残っている",
    memories.every((m) => Boolean(m.origin)),
  );
  check(
    "本人が確定した日時が、確定した記憶すべてに残っている",
    memories
      .filter((m) => ["confirmed", "archived", "superseded"].includes(String(m.status)))
      .every((m) => Boolean(m.confirmedAt)),
  );

  // --- AIへ送らない印 ---
  const excluded = messages.filter((m) => m.excludedFromAiAt);
  check(
    "AIへ送らない印が、そのまま残っている",
    one(`select count(*)::int as n from ${S}.messages where excluded_from_ai_at is not null`) ===
      excluded.length,
    `印の付いた発言：${excluded.length} 件`,
  );

  // --- 出典の墓標 ---
  const tombstones = references.filter((r) => !r.memoryId);
  check(
    "消えた記憶の出典（墓標）が、そのまま残っている",
    one(`select count(*)::int as n from ${S}.memory_references where memory_id is null`) ===
      tombstones.length,
    `墓標：${tombstones.length} 件`,
  );
  check(
    "墓標には、消えた日時が残っている",
    tombstones.every((r) => Boolean(r.memoryDeletedAt)),
  );

  // =========================================================
  // ⑤ 消したものが復活していないか（いちばん大事）
  // =========================================================
  check(
    "消した記憶の本文が、ファイルにも入っていない",
    memories
      .filter((m) => m.status === "deleted")
      .every((m) => !m.text && !m.aiSuggestedText && !m.confirmedText),
  );
  check(
    "「残さない」と決めた候補の本文が、入っていない",
    memories
      .filter((m) => m.status === "rejected")
      .every((m) => !m.text && !m.aiSuggestedText && !m.confirmedText),
  );
  check(
    "期限が過ぎた候補の本文が、入っていない",
    memories
      .filter((m) => m.status === "expired")
      .every((m) => !m.text && !m.aiSuggestedText && !m.confirmedText),
  );
  check(
    "読み込んだあとも、消した記憶に本文が無い",
    mismatch(`select count(*)::int as n from ${S}.memory_candidates
              where status in ('deleted','rejected','expired')
                and (suggested_text is not null or confirmed_text is not null)`),
  );
  check(
    "消した記憶が「いまの記憶」に戻っていない",
    mismatch(`select count(*)::int as n from ${S}.confirmed_memories cm
              join ${S}.memory_candidates mc on mc.id = cm.id
              where mc.deleted_at is not null`),
  );
  check(
    "消した記憶が「昔の考え」にも戻っていない",
    mismatch(`select count(*)::int as n from ${S}.past_memories pm
              join ${S}.memory_candidates mc on mc.id = pm.id
              where mc.deleted_at is not null`),
  );
  check(
    "訂正される前の内容が「いまの記憶」に戻っていない",
    mismatch(`select count(*)::int as n from ${S}.memory_candidates o
              join ${S}.memory_candidates n on n.revision_of = o.id
              where n.revision_kind = 'correction' and o.status = 'confirmed'`),
  );

  // --- ほかの人のデータが混ざっていないか ---
  check(
    "入っているのは、持ち主1人ぶんだけ",
    one(`select count(distinct user_id)::int as n from ${S}.memory_candidates`) <= 1 &&
      one(`select count(distinct user_id)::int as n from ${S}.conversations`) <= 1,
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
    console.log(`すべて一致（${checks.length} 項目）。`);
    console.log("書き出したファイルから、関係を組み直せることを確認しました。");
  } else {
    console.log(`一致しない ${ng.length} 件 / ${checks.length} 項目。`);
    process.exit(1);
  }
}

/** 読み込む先の形を作る（いま動いている場所の形をそのまま写す） */
function buildSchemaSql(): string {
  return `
    drop schema if exists ${S} cascade;
    create schema ${S};

    create table ${S}.conversations (like public.conversations including all);
    create table ${S}.messages (like public.messages including all);
    create table ${S}.memory_candidates (like public.memory_candidates including all);
    create table ${S}.memory_references (like public.memory_references including all);

    alter table ${S}.messages
      add constraint m_conv_fk foreign key (conversation_id) references ${S}.conversations (id) on delete cascade;

    alter table ${S}.memory_candidates
      add constraint mc_conv_fk foreign key (conversation_id) references ${S}.conversations (id) on delete cascade,
      add constraint mc_src_fk foreign key (source_message_id) references ${S}.messages (id) on delete cascade,
      add constraint mc_rev_fk foreign key (revision_of) references ${S}.memory_candidates (id) deferrable initially deferred,
      add constraint mc_sup_fk foreign key (superseded_by) references ${S}.memory_candidates (id) deferrable initially deferred;

    alter table ${S}.memory_references
      add constraint mr_msg_fk foreign key (message_id) references ${S}.messages (id) on delete cascade,
      add constraint mr_mem_fk foreign key (memory_id) references ${S}.memory_candidates (id) on delete set null;

    create view ${S}.confirmed_memories as
      select id, user_id, conversation_id, source_message_id,
             coalesce(confirmed_text, suggested_text) as text,
             origin, requested_by_user, created_at, confirmed_at, version
      from ${S}.memory_candidates where status = 'confirmed';

    create view ${S}.past_memories as
      select id, user_id, conversation_id, source_message_id,
             coalesce(confirmed_text, suggested_text) as text,
             origin, version, revised_at, superseded_by, created_at, confirmed_at
      from ${S}.memory_candidates where status = 'archived';
  `;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

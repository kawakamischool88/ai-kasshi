import type { SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import {
  EXCLUSION_LABEL,
  EXPORT_FILES,
  EXPORT_FORMAT_VERSION,
  FORBIDDEN_IN_EXPORT,
  MEMORY_STATE_LABEL,
  NOT_EXPORTED,
  ORIGIN_LABEL,
  REVISION_LABEL,
} from "@/config/export";

/**
 * 本人向けデータ書き出しの中身を作る（Phase 4B）。
 *
 * 【ほかの人のデータが混ざらない作り】
 * ここへ渡すのは **ログイン中の本人の接続**。
 * その接続では、DBの決まり（RLS）によって本人の行しか読めない。
 * 「絞り忘れ」があっても、そもそも他人の行は返ってこない。
 * その上で、問い合わせにも user_id の条件を書く（二重の守り）。
 *
 * 【消したものを復活させない作り】
 * 本文は memory_candidates にある値をそのまま使う。
 * 消した・残さないと決めた・期限が過ぎた候補は、
 * DBの決まりで**本文を持てない**（Phase 4A）ので、ここでも空になる。
 * さらに、作り終えたあとに本文が混ざっていないかを調べる。
 */

export type ExportResult =
  | { ok: true; zip: Uint8Array; fileName: string; summary: ExportSummary }
  | { ok: false; reason: "changed" | "forbidden" | "failed"; message: string };

export type ExportSummary = {
  conversations: number;
  messages: number;
  memoriesCurrent: number;
  memoriesPast: number;
  memoriesPending: number;
  memoriesRemoved: number;
  references: number;
  bytes: number;
  durationMs: number;
};

type Row = Record<string, unknown>;

/** 作り始めと作り終わりで、内容が変わっていないかを見るための印 */
async function fingerprint(supabase: SupabaseClient, userId: string): Promise<string> {
  const [memories, conversations, messages, references] = await Promise.all([
    supabase
      .from("memory_candidates")
      .select("id, version, status, deleted_at, revised_at")
      .eq("user_id", userId)
      .order("id"),
    supabase.from("conversations").select("id, title").eq("user_id", userId).order("id"),
    supabase
      .from("messages")
      .select("id, excluded_from_ai_at")
      .eq("user_id", userId)
      .order("id"),
    supabase
      .from("memory_references")
      .select("id, memory_id, memory_deleted_at")
      .eq("user_id", userId)
      .order("id"),
  ]);

  if (memories.error || conversations.error || messages.error || references.error) {
    throw new Error("いまの状態を確かめられませんでした");
  }

  return JSON.stringify([
    memories.data,
    conversations.data,
    messages.data,
    references.data,
  ]);
}

/**
 * 書き出しを作る。
 *
 * 作っている途中で本人が記憶を消したり直したりしたら、
 * **古い内容を含んだファイルを渡さない**（作り直してもらう）。
 * 回答を作るときと同じ考え方（Phase 3D）。
 */
export async function buildExport(
  supabase: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<ExportResult> {
  const startedAt = Date.now();

  try {
    // --- 作り始めの状態を控える ---
    const before = await fingerprint(supabase, userId);

    // --- 本人のデータを読む（RLS に加えて user_id も明示） ---
    const [conv, msg, mem, ref, prof] = await Promise.all([
      supabase
        .from("conversations")
        .select("id, title, created_at, last_message_at")
        .eq("user_id", userId)
        .order("created_at"),
      supabase
        .from("messages")
        .select("id, conversation_id, role, content, created_at, excluded_from_ai_at, exclusion_reason")
        .eq("user_id", userId)
        .order("created_at"),
      supabase
        .from("memory_candidates")
        .select(
          "id, conversation_id, source_message_id, candidate_index, suggested_text, confirmed_text," +
            " origin, requested_by_user, status, created_at, confirmed_at, expires_at," +
            " revision_of, revision_kind, superseded_by, version, revised_at, deleted_at",
        )
        .eq("user_id", userId)
        .order("created_at"),
      supabase
        .from("memory_references")
        .select("id, message_id, memory_id, memory_deleted_at, created_at")
        .eq("user_id", userId)
        .order("created_at"),
      supabase
        .from("profiles")
        .select("display_name, memo, created_at")
        .eq("id", userId)
        .maybeSingle(),
    ]);

    for (const r of [conv, msg, mem, ref]) {
      if (r.error) throw new Error(r.error.message);
    }

    // --- 本人に分かる形に整える（内部のidは残す。別の場所で組み直すのに要る） ---
    /* 型の推測が効かない書き方（列名を複数行で組み立てている）があるため、
       ここで素の形に直してから読む。読む内容は上の select と同じ。 */
    const convRows = (conv.data ?? []) as unknown as Row[];
    const msgRows = (msg.data ?? []) as unknown as Row[];
    const memRows = (mem.data ?? []) as unknown as Row[];
    const refRows = (ref.data ?? []) as unknown as Row[];

    const conversations = convRows.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.created_at,
      lastMessageAt: c.last_message_at,
    }));

    const messages = msgRows.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      speaker: m.role === "user" ? "本人" : "AIカッシー",
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      /* この発言をAIへ送らないことにした日時（Phase 3D）。
         訂正・削除の影響を受けた古いやりとりに付く。画面には出ている。 */
      excludedFromAiAt: m.excluded_from_ai_at,
      exclusionReason: m.exclusion_reason,
      exclusionReasonLabel: m.exclusion_reason
        ? (EXCLUSION_LABEL[m.exclusion_reason as string] ?? String(m.exclusion_reason))
        : null,
    }));

    const memories = memRows.map((m) => {
      const status = m.status as string;
      /* 本文は、DBにある値をそのまま使う。
         消した・残さない・期限切れは、DBの決まりで本文を持てない（Phase 4A）。 */
      const text = (m.confirmed_text as string) ?? (m.suggested_text as string) ?? null;
      return {
        id: m.id,
        status,
        statusLabel: MEMORY_STATE_LABEL[status] ?? status,
        /** いまの内容（消したものは空） */
        text,
        /** AIカッシーが提案した文章 */
        aiSuggestedText: m.suggested_text,
        /** 本人が確定した文章（直したときは直した後のもの） */
        confirmedText: m.confirmed_text,
        /** 本人が文章を直したか */
        editedByOwner:
          Boolean(m.confirmed_text) &&
          Boolean(m.suggested_text) &&
          m.confirmed_text !== m.suggested_text,
        origin: m.origin,
        originLabel: ORIGIN_LABEL[m.origin as string] ?? m.origin,
        requestedByUser: m.requested_by_user,
        conversationId: m.conversation_id,
        /** もとになった本人の発言 */
        sourceMessageId: m.source_message_id,
        candidateIndex: m.candidate_index,
        /** 何代目の内容か */
        version: m.version,
        /** 置き換えた前の記憶 */
        revisionOf: m.revision_of,
        revisionKind: m.revision_kind,
        revisionKindLabel: m.revision_kind
          ? (REVISION_LABEL[m.revision_kind as string] ?? m.revision_kind)
          : null,
        /** この記憶を置き換えた新しい記憶 */
        supersededBy: m.superseded_by,
        createdAt: m.created_at,
        confirmedAt: m.confirmed_at,
        revisedAt: m.revised_at,
        expiresAt: m.expires_at,
        deletedAt: m.deleted_at,
      };
    });

    const references = refRows.map((r) => ({
      id: r.id,
      /** どのAIの返事で使ったか */
      messageId: r.message_id,
      /** どの記憶を使ったか。消えた記憶は空（墓標） */
      memoryId: r.memory_id,
      /** 参考にした記憶が消された日時 */
      memoryDeletedAt: r.memory_deleted_at,
      createdAt: r.created_at,
    }));

    const summaryCounts = {
      conversations: conversations.length,
      messages: messages.length,
      memoriesCurrent: memories.filter((m) => m.status === "confirmed").length,
      memoriesPast: memories.filter((m) => m.status === "archived").length,
      memoriesPending: memories.filter((m) => m.status === "pending").length,
      memoriesRemoved: memories.filter((m) =>
        ["deleted", "rejected", "expired"].includes(m.status),
      ).length,
      references: references.length,
    };

    const manifest = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      /** このデータの持ち主。別の場所で組み直すときに要る */
      ownerUserId: userId,
      owner: {
        displayName: prof.data?.display_name ?? null,
        memo: prof.data?.memo ?? null,
        since: prof.data?.created_at ?? null,
      },
      app: { name: "AIカッシー", version: "Ver.0.1" },
      contents: {
        conversations: { file: EXPORT_FILES.conversations, count: conversations.length },
        messages: { file: EXPORT_FILES.messages, count: messages.length },
        memories: { file: EXPORT_FILES.memories, count: memories.length },
        references: { file: EXPORT_FILES.references, count: references.length },
      },
      counts: summaryCounts,
      files: Object.values(EXPORT_FILES),
      notExported: NOT_EXPORTED,
      note:
        "本人が自分のデータを手元に持っておくためのファイルです。" +
        "運営がシステムを復旧するためのバックアップとは別のものです。",
    };

    // --- ファイルにする ---
    const zip = new JSZip();
    const json = (v: unknown) => JSON.stringify(v, null, 2);
    zip.file(EXPORT_FILES.manifest, json(manifest));
    zip.file(EXPORT_FILES.conversations, json(conversations));
    zip.file(EXPORT_FILES.messages, json(messages));
    zip.file(EXPORT_FILES.memories, json(memories));
    zip.file(EXPORT_FILES.references, json(references));
    zip.file(EXPORT_FILES.readme, readme(manifest));

    // --- 渡す前に調べる ---
    const allText = [
      json(manifest),
      json(conversations),
      json(messages),
      json(memories),
      json(references),
    ].join("\n");

    for (const word of FORBIDDEN_IN_EXPORT) {
      if (allText.includes(word)) {
        console.error(`[書き出し] 入れてはいけない文字が混ざっています：${word}`);
        return {
          ok: false,
          reason: "forbidden",
          message: "書き出しを作れませんでした。管理者にお知らせください。",
        };
      }
    }

    // 消したものの本文が混ざっていないか
    const leaked = memories.find(
      (m) =>
        ["deleted", "rejected", "expired"].includes(m.status) &&
        (m.text || m.aiSuggestedText || m.confirmedText),
    );
    if (leaked) {
      console.error("[書き出し] 消した内容の本文が混ざっています");
      return {
        ok: false,
        reason: "forbidden",
        message: "書き出しを作れませんでした。管理者にお知らせください。",
      };
    }

    // ほかの人のidが混ざっていないか（自分のid以外の見知らぬidが無いこと）
    const known = new Set<string>([
      userId,
      ...conversations.map((c) => String(c.id)),
      ...messages.map((m) => String(m.id)),
      ...memories.map((m) => String(m.id)),
      ...references.map((r) => String(r.id)),
    ]);
    const uuids = allText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
    for (const id of new Set(uuids ?? [])) {
      if (!known.has(id)) {
        console.error("[書き出し] 見知らぬidが混ざっています");
        return {
          ok: false,
          reason: "forbidden",
          message: "書き出しを作れませんでした。管理者にお知らせください。",
        };
      }
    }

    // --- 作っている間に、本人が消したり直したりしていないか ---
    const after = await fingerprint(supabase, userId);
    if (before !== after) {
      return {
        ok: false,
        reason: "changed",
        message:
          "書き出しを作っている間に、記憶の内容が変わりました。" +
          "古い内容のファイルはお渡ししません。もう一度お試しください。",
      };
    }

    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    return {
      ok: true,
      zip: bytes,
      fileName: `AIカッシー_自分のデータ_${stamp(now)}.zip`,
      summary: { ...summaryCounts, bytes: bytes.length, durationMs: Date.now() - startedAt },
    };
  } catch (e) {
    console.error("[書き出し] 想定外のエラー:", e);
    return {
      ok: false,
      reason: "failed",
      message: "書き出しを作れませんでした。もう一度お試しください。",
    };
  }
}

function stamp(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
    `_${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}`
  );
}

/** ZIPを開いた人が、まず読む説明。専門用語を使わない */
function readme(manifest: {
  exportedAt: string;
  counts: Record<string, number>;
  notExported: { name: string; reason: string }[];
}): string {
  const c = manifest.counts;
  const lines = [
    "AIカッシー｜自分のデータ",
    "",
    `書き出した日時：${new Date(manifest.exportedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    "",
    "■ このファイルは何ですか",
    "AIカッシーに残してある、あなたの会話と記憶をまとめたものです。",
    "ご自分のパソコンやiPadに保存しておけます。",
    "",
    "■ 入っているもの",
    `・会話　　　　　　${c.conversations} 件`,
    `・やりとり　　　　${c.messages} 件`,
    `・いまの記憶　　　${c.memoriesCurrent} 件`,
    `・昔の考え　　　　${c.memoriesPast} 件`,
    `・確認待ちの記憶　${c.memoriesPending} 件`,
    `・参考にした記録　${c.references} 件`,
    "",
    "■ 入っていないもの",
    ...manifest.notExported.map((n) => `・${n.name}\n　　${n.reason}`),
    "",
    "■ ファイルの読み方",
    "中のファイルは、機械が読み取りやすい形（JSON）で入っています。",
    "そのままでは読みにくいので、内容を見たいときは川上さんへお申し付けください。",
    "",
    "■ 消した記憶について",
    "消した記憶の本文は、このファイルに入っていません。",
    "ただし「記憶だけ消す」を選んだときは、そのときの会話は残ります。",
    "（AIカッシーの画面で読めるものと同じです）",
    "その会話は、AIカッシーの返事には使われないよう印が付いています。",
    "会話ごと消したいときは、会話の画面の「この会話を消す」をお使いください。",
    "",
    "■ 大切なお願い",
    "このファイルには、あなたが話した内容がそのまま入っています。",
    "ほかの人に渡したり、共有フォルダに置いたりしないでください。",
    "",
    "なお、いったんご自分の機器へ保存されたこのファイルは、",
    "AIカッシー側から消すことができません。保管にはご注意ください。",
  ];
  return lines.join("\r\n");
}

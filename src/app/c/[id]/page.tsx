import { notFound, redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { AI } from "@/config/ai";
import { expireOldCandidates } from "@/app/actions";
import { Header } from "@/app/Header";
import { Chat } from "./Chat";
import type { Candidate } from "./MemoryCard";
import type { SourceMemory, SourceState } from "./MemorySource";
import type { RevisionProposal } from "./RevisionCard";
import { DeleteConversation } from "./DeleteConversation";
import { formatDateTimeJst } from "@/lib/time";

/** 出典や提案を表示するために読む列 */
const MEMORY_COLUMNS =
  "id, suggested_text, confirmed_text, status, superseded_by, conversation_id, confirmed_at, deleted_at";

/** 1つの会話の画面。開き直したときは、これまでのやりとりがそのまま出る */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により、自分の会話でなければ何も返らない
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();
  if (!conversation) notFound();

  const [{ data: messages }, budget] = await Promise.all([
    supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
    getBudgetStatus(supabase, user.id),
  ]);

  const list = (messages ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as "user" | "assistant",
    content: m.content as string,
  }));

  // 最後が自分の発言のまま止まっている＝返事をもらえていない
  const needsRetry = list.length > 0 && list[list.length - 1].role === "user";

  /* 本人確認待ちの記憶候補（Phase 3A）。
     先に期限切れの印を付けてから引く。閲覧では期限は延びない。
     ［残さない］にしたものと期限切れは、この一覧に出てこない。

     出すのは「いちばん新しい本人の発言から作られた候補」だけ。
     答えないまま話を続けたときに、古い確認が画面にたまらないようにする。 */
  await expireOldCandidates(supabase);
  const lastUserMessageId = [...list].reverse().find((m) => m.role === "user")?.id;

  const { data: pending } = lastUserMessageId
    ? await supabase
        .from("memory_candidates")
        .select("id, suggested_text, requested_by_user")
        .eq("source_message_id", lastUserMessageId)
        .eq("status", "pending")
        .order("candidate_index", { ascending: true })
    : { data: [] };

  const candidates: Candidate[] = (pending ?? [])
    .filter((c) => c.suggested_text)
    .map((c) => ({
      id: c.id as string,
      text: c.suggested_text as string,
      requested: Boolean(c.requested_by_user),
    }));

  const [sources, proposals, { count: memoryCount }] = await Promise.all([
    loadSources(supabase, list, id),
    loadRevisionProposals(supabase, lastUserMessageId),
    // この会話から作られた記憶の件数（会話ごと消すときに範囲を示すため）
    supabase
      .from("memory_candidates")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", id)
      .in("status", ["pending", "confirmed", "archived"]),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-8">
      <Header backHref="/" />
      <Chat
        conversationId={conversation.id}
        messages={list}
        needsRetry={needsRetry}
        budgetStopped={budget.state === "stopped"}
        maxInputChars={AI.maxInputChars}
        candidates={candidates}
        sources={sources}
        proposals={proposals}
      />
      <DeleteConversation
        conversationId={conversation.id}
        memoryCount={memoryCount ?? 0}
        messageCount={list.length}
      />
    </main>
  );
}

/** 記憶の状態を、画面で使う言い方に直す */
function toSourceState(status: string): SourceState | null {
  if (status === "confirmed") return "current";
  if (status === "superseded") return "corrected";
  if (status === "archived") return "past";
  if (status === "deleted") return "deleted";
  return null; // 未確定・却下・期限切れは出典に出さない
}

type MemoryRow = {
  id: string;
  text: string | null;
  status: string;
  supersededBy: string | null;
  conversationId: string;
  confirmedAt: string | null;
  deletedAt: string | null;
};

function toMemoryRow(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    text: ((r.confirmed_text as string) ?? (r.suggested_text as string) ?? null) as string | null,
    status: r.status as string,
    supersededBy: ((r.superseded_by as string) ?? null) as string | null,
    conversationId: r.conversation_id as string,
    confirmedAt: ((r.confirmed_at as string) ?? null) as string | null,
    deletedAt: ((r.deleted_at as string) ?? null) as string | null,
  };
}

/**
 * 出典（Phase 3B / 3C）。
 *
 * AIが実際に使った確定記憶だけが memory_references に入っている。
 * RLS により、取れるのは本人のぶんだけ。
 *
 * 【ここだけ memory_candidates を直接読む理由】
 * 検索・AI回答への注入は、必ず確定済みだけの view を使う決まり（Phase 3B）。
 * ただし出典の表示では「そのあと訂正された・消された」ことも伝えたいので、
 * 状態を知る必要がある。**表示のためだけの読み取りで、AIには渡さない。**
 */
async function loadSources(
  supabase: SupabaseClient,
  list: { id: string; role: string }[],
  conversationId: string,
): Promise<Record<string, SourceMemory[]>> {
  const assistantIds = list.filter((m) => m.role === "assistant").map((m) => m.id);
  const sources: Record<string, SourceMemory[]> = {};
  if (assistantIds.length === 0) return sources;

  const { data: refs } = await supabase
    .from("memory_references")
    .select("message_id, memory_id, memory_deleted_at")
    .in("message_id", assistantIds);

  if (!refs || refs.length === 0) return sources;

  const memoryIds = [
    ...new Set(
      refs.map((r) => r.memory_id as string | null).filter((v): v is string => Boolean(v)),
    ),
  ];

  const rows = new Map<string, MemoryRow>();
  if (memoryIds.length > 0) {
    const { data: first } = await supabase
      .from("memory_candidates")
      .select(MEMORY_COLUMNS)
      .in("id", memoryIds);
    for (const r of first ?? []) rows.set(r.id as string, toMemoryRow(r));
  }

  /* 訂正・考えの変化のあとの「いまの内容」をたどる。
     何度も直されていることがあるので、数回だけ先へたどる。 */
  for (let hop = 0; hop < 3; hop++) {
    const next = [...rows.values()]
      .map((r) => r.supersededBy)
      .filter((v): v is string => v !== null && !rows.has(v));
    if (next.length === 0) break;
    const { data } = await supabase.from("memory_candidates").select(MEMORY_COLUMNS).in("id", next);
    for (const r of data ?? []) rows.set(r.id as string, toMemoryRow(r));
  }

  // 元になった会話の見出し
  const convIds = [...new Set([...rows.values()].map((r) => r.conversationId))];
  const { data: convs } = convIds.length
    ? await supabase.from("conversations").select("id, title").in("id", convIds)
    : { data: [] };
  const titleOf = new Map((convs ?? []).map((c) => [c.id as string, (c.title as string) ?? ""]));

  /** 訂正・変化の先をたどって、いま有効な内容を探す */
  const currentTextOf = (row: MemoryRow): string => {
    let cursor = row.supersededBy;
    for (let hop = 0; hop < 4 && cursor; hop++) {
      const next = rows.get(cursor);
      if (!next) return "";
      if (next.status === "confirmed") return next.text ?? "";
      if (next.status === "deleted") return "";
      cursor = next.supersededBy;
    }
    return "";
  };

  for (const r of refs) {
    const key = r.message_id as string;
    const memoryId = r.memory_id as string | null;
    const row = memoryId ? rows.get(memoryId) : undefined;

    /* 【墓標】記憶そのものが消えている（会話ごと削除など）。
       出典の行だけが残っている状態。本文は出さない。 */
    if (!row) {
      const at = r.memory_deleted_at as string | null;
      sources[key] = [
        ...(sources[key] ?? []),
        {
          id: `${key}-gone-${sources[key]?.length ?? 0}`,
          text: "",
          confirmedAt: "",
          state: "deleted",
          deletedAt: at ? formatDateTimeJst(at) : "",
          currentText: "",
          conversationId: "",
          conversationTitle: "",
          isSameConversation: false,
        },
      ];
      continue;
    }

    const state = toSourceState(row.status);
    if (!state) continue;

    const memory: SourceMemory = {
      id: row.id,
      text: state === "deleted" ? "" : (row.text ?? ""),
      confirmedAt:
        state === "deleted" || !row.confirmedAt ? "" : formatDateTimeJst(row.confirmedAt),
      state,
      deletedAt: row.deletedAt ? formatDateTimeJst(row.deletedAt) : "",
      currentText: state === "corrected" || state === "past" ? currentTextOf(row) : "",
      conversationId: row.conversationId,
      conversationTitle: titleOf.get(row.conversationId) ?? "",
      isSameConversation: row.conversationId === conversationId,
    };

    sources[key] = [...(sources[key] ?? []), memory];
  }

  return sources;
}

/**
 * 記憶の訂正・変化・削除の提案（Phase 3C）。
 *
 * 出すのは「いちばん新しい本人の発言から作られた提案」だけ。
 * ［そのままにする］にしたものと、済んだものは出てこない。
 *
 * **ここに出ている間は、記憶はまだ何も変わっていない。**
 */
async function loadRevisionProposals(
  supabase: SupabaseClient,
  lastUserMessageId: string | undefined,
): Promise<RevisionProposal[]> {
  if (!lastUserMessageId) return [];

  const { data: requests } = await supabase
    .from("memory_revision_requests")
    .select("id, intent, target_memory_id, proposed_text")
    .eq("source_message_id", lastUserMessageId)
    .eq("status", "pending")
    .order("request_index", { ascending: true });

  if (!requests || requests.length === 0) return [];

  const targetIds = requests.map((r) => r.target_memory_id as string);
  const { data: targets } = await supabase
    .from("memory_candidates")
    .select("id, suggested_text, confirmed_text, status")
    .in("id", targetIds);

  const targetOf = new Map(
    (targets ?? []).map((t) => [
      t.id as string,
      {
        text: ((t.confirmed_text as string) ?? (t.suggested_text as string) ?? "") as string,
        status: t.status as string,
      },
    ]),
  );

  const out: RevisionProposal[] = [];
  for (const r of requests) {
    const target = targetOf.get(r.target_memory_id as string);
    // すでに直された・消された記憶の提案は、もう出さない
    if (!target) continue;
    if (target.status !== "confirmed" && target.status !== "archived") continue;

    /* 消したときに一緒に消える版の数。本人に削除の範囲を示すため。
       たどるのはDB側（自分の記憶だけ）。 */
    let versionCount = 1;
    if (r.intent === "delete") {
      const { data: chain } = await supabase.rpc("memory_chain", {
        target: r.target_memory_id as string,
      });
      if (Array.isArray(chain) && chain.length > 0) versionCount = chain.length;
    }

    out.push({
      id: r.id as string,
      intent: r.intent as RevisionProposal["intent"],
      currentText: target.text,
      proposedText: (r.proposed_text as string) ?? "",
      isPast: target.status === "archived",
      versionCount,
    });
  }
  return out;
}

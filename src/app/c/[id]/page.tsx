import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { AI } from "@/config/ai";
import { expireOldCandidates } from "@/app/actions";
import { Header } from "@/app/Header";
import { Chat } from "./Chat";
import type { Candidate } from "./MemoryCard";
import type { SourceMemory } from "./MemorySource";
import { formatDateTimeJst } from "@/lib/time";

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
    getBudgetStatus(supabase),
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

  const candidates: Candidate[] = (pending ?? []).map((c) => ({
    id: c.id as string,
    text: c.suggested_text as string,
    requested: Boolean(c.requested_by_user),
  }));

  /* 出典（Phase 3B）。
     AIが実際に使った確定記憶だけが memory_references に入っている。
     RLS により、取れるのは本人のぶんだけ。 */
  const assistantIds = list.filter((m) => m.role === "assistant").map((m) => m.id);
  const sources: Record<string, SourceMemory[]> = {};

  if (assistantIds.length > 0) {
    const { data: refs } = await supabase
      .from("memory_references")
      .select("message_id, memory_id")
      .in("message_id", assistantIds);

    const memoryIds = [...new Set((refs ?? []).map((r) => r.memory_id as string))];
    if (memoryIds.length > 0) {
      // 確定済みだけを見せる view から引く（未確定・却下・期限切れは出てこない）
      const { data: mems } = await supabase
        .from("confirmed_memories")
        .select("id, text, conversation_id, confirmed_at")
        .in("id", memoryIds);

      // 元になった会話の見出し
      const convIds = [...new Set((mems ?? []).map((m) => m.conversation_id as string))];
      const { data: convs } = convIds.length
        ? await supabase.from("conversations").select("id, title").in("id", convIds)
        : { data: [] };
      const titleOf = new Map((convs ?? []).map((c) => [c.id as string, (c.title as string) ?? ""]));

      const byId = new Map(
        (mems ?? []).map((m) => [
          m.id as string,
          {
            id: m.id as string,
            text: m.text as string,
            confirmedAt: m.confirmed_at ? formatDateTimeJst(m.confirmed_at as string) : "",
            conversationId: m.conversation_id as string,
            conversationTitle: titleOf.get(m.conversation_id as string) ?? "",
            isSameConversation: (m.conversation_id as string) === id,
          } satisfies SourceMemory,
        ]),
      );

      for (const r of refs ?? []) {
        const mem = byId.get(r.memory_id as string);
        if (!mem) continue; // 確定でなくなった記憶は出典に出さない
        const key = r.message_id as string;
        sources[key] = [...(sources[key] ?? []), mem];
      }
    }
  }

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
      />
    </main>
  );
}

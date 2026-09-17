import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { AI } from "@/config/ai";
import { expireOldCandidates } from "@/app/actions";
import { Header } from "@/app/Header";
import { Chat } from "./Chat";
import type { Candidate } from "./MemoryCard";

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
      />
    </main>
  );
}

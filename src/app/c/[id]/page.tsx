import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { AI } from "@/config/ai";
import { Header } from "@/app/Header";
import { Chat } from "./Chat";

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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-8">
      <Header backHref="/" />
      <Chat
        conversationId={conversation.id}
        messages={list}
        needsRetry={needsRetry}
        budgetStopped={budget.state === "stopped"}
        maxInputChars={AI.maxInputChars}
      />
    </main>
  );
}

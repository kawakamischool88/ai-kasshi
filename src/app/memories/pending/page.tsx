import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { expireOldCandidates } from "@/app/actions";
import { Header } from "@/app/Header";
import { formatDateTimeJst } from "@/lib/time";
import { PendingList } from "./PendingList";

/**
 * 確認待ちの記憶（Phase 3B）。
 *
 * Phase 3A では、答えないまま会話を続けると候補が画面から消えてしまった。
 * ここで後からまとめて確認できるようにする。
 *
 * 出すのは「本人確認待ち」かつ「期限内」のものだけ。
 * ［残さない］にしたもの・期限切れ・確定済みは出てこない。
 */
export default async function PendingMemoriesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 先に期限切れの印を付ける。見ただけで期限は延びない
  await expireOldCandidates(supabase);

  const { data: rows } = await supabase
    .from("memory_candidates")
    .select("id, suggested_text, requested_by_user, created_at, expires_at, conversation_id")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  const list = rows ?? [];
  const convIds = [...new Set(list.map((r) => r.conversation_id as string))];
  const { data: convs } = convIds.length
    ? await supabase.from("conversations").select("id, title").in("id", convIds)
    : { data: [] };
  const titleOf = new Map((convs ?? []).map((c) => [c.id as string, (c.title as string) ?? ""]));

  const items = list.map((r) => ({
    id: r.id as string,
    text: r.suggested_text as string,
    requested: Boolean(r.requested_by_user),
    createdAt: formatDateTimeJst(r.created_at as string),
    expiresAt: formatDateTimeJst(r.expires_at as string),
    conversationId: r.conversation_id as string,
    conversationTitle: titleOf.get(r.conversation_id as string) ?? "",
  }));

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Header backHref="/" />

      <h2 className="mt-8 text-xl font-bold">確認待ちの記憶</h2>
      <p className="m-0 mt-2 text-base text-neutral-600">
        カッシーに残すかどうか、まだ決めていないものです。
        <br />
        作られてから30日をすぎると、自動でなくなります。
      </p>

      {items.length === 0 ? (
        <p className="mt-8 rounded-2xl border border-line bg-white px-5 py-6 text-lg">
          いま確認をお待ちしているものはありません。
        </p>
      ) : (
        <PendingList items={items} />
      )}
    </main>
  );
}

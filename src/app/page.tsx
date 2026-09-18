import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { hasApiKey } from "@/lib/ai/anthropic";
import { isAdmin } from "@/lib/auth/admin";
import { formatDateTimeJst } from "@/lib/time";
import { createConversation, expireOldCandidates } from "./actions";
import { Header } from "./Header";

/** 会話の一覧。ここから新しく話し始めるか、過去の会話を開き直す */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 確認待ちの件数を数える前に、期限切れの印を付ける
  await expireOldCandidates(supabase);

  const [
    { data: conversations },
    budget,
    { count: pendingCount },
    { count: memoryCount },
    admin,
  ] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, last_message_at")
      .order("last_message_at", { ascending: false })
      .limit(100),
    getBudgetStatus(supabase, user.id),
    supabase
      .from("memory_candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString()),
    // 残してある内容の件数（Phase 3C）
    supabase.from("confirmed_memories").select("id", { count: "exact", head: true }),
    // 運営用の入口を出すかどうか（サーバー側で判定する）
    isAdmin(supabase),
  ]);

  const list = conversations ?? [];

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Header />

      {!hasApiKey() && (
        <p className="mt-6 border-l-4 border-red-700 bg-white px-4 py-4" role="alert">
          AIの設定がまだ済んでいません。管理者にお知らせください。
        </p>
      )}

      {budget.state === "stopped" && (
        <p className="mt-6 border-l-4 border-red-700 bg-white px-4 py-4" role="alert">
          今月のAIの利用上限に達したため、新しい返事は止めています。
          <br />
          これまでの会話は、これまで通り読めます。
        </p>
      )}
      {budget.state === "warning" && (
        <p className="mt-6 border-l-4 border-accent bg-white px-4 py-4" role="status">
          今月のAIの利用が、目安の金額を超えました。
        </p>
      )}

      <form action={createConversation} className="mt-8">
        <button
          type="submit"
          className="min-h-16 w-full rounded bg-accent px-6 text-xl font-bold text-white hover:opacity-90"
        >
          新しく話す
        </button>
      </form>

      {/* 確認待ちの記憶があるときだけ入口を出す（Phase 3B） */}
      {(pendingCount ?? 0) > 0 && (
        <Link
          href="/memories/pending"
          className="mt-6 flex min-h-16 items-center gap-3 rounded-2xl border-2 border-line bg-white px-5 text-lg no-underline"
        >
          <span aria-hidden="true" className="text-2xl">
            🧠
          </span>
          確認待ちの記憶 {pendingCount}件
          <span aria-hidden="true" className="ml-auto">
            ›
          </span>
        </Link>
      )}

      {/* 残してある内容の一覧（Phase 3C）。
          訂正・考えの変化・削除は会話の中でもできるが、
          対象を自分の目で確かめて確実に消せる場所も用意する */}
      <Link
        href="/memories"
        className="mt-4 flex min-h-16 items-center gap-3 rounded-2xl border-2 border-line bg-white px-5 text-lg no-underline"
      >
        <span aria-hidden="true" className="text-2xl">
          📒
        </span>
        カッシーに残してある内容 {memoryCount ?? 0}件
        <span aria-hidden="true" className="ml-auto">
          ›
        </span>
      </Link>

      <section className="mt-10">
        <h2 className="text-lg font-bold">これまでの会話</h2>

        {list.length === 0 ? (
          <p className="mt-4 text-neutral-600">まだ会話はありません。</p>
        ) : (
          <ul className="m-0 mt-4 list-none p-0">
            {list.map((c) => (
              <li key={c.id} className="border-b border-line first:border-t">
                <Link
                  href={`/c/${c.id}`}
                  className="flex min-h-16 flex-col justify-center gap-1 px-1 py-3 no-underline"
                >
                  <span className="text-lg">{c.title || "（まだ話していません）"}</span>
                  <span className="text-sm text-neutral-600">
                    {formatDateTimeJst(c.last_message_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 運営（管理者）だけに出す入口。
          通常の利用者には、この行そのものが出ない。
          なお、入口を消すのは「見えない」だけで守りにはならない。
          本当の守りは /cost 側の権限確認と、DB の RLS にある。 */}
      {admin && (
        <footer className="mt-16 border-t border-line pt-5 text-sm text-neutral-600">
          <Link href="/cost" className="underline underline-offset-4">
            利用状況（運営用）
          </Link>
        </footer>
      )}
    </main>
  );
}

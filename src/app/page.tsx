import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { hasApiKey } from "@/lib/ai/anthropic";
import { formatDateTimeJst } from "@/lib/time";
import { createConversation } from "./actions";
import { Header } from "./Header";

/** 会話の一覧。ここから新しく話し始めるか、過去の会話を開き直す */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: conversations }, budget] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, last_message_at")
      .order("last_message_at", { ascending: false })
      .limit(100),
    getBudgetStatus(supabase),
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

      {/* 開発確認用。柏村さんが使い始める前に、見えないようにするか管理者だけに限る */}
      <footer className="mt-16 border-t border-line pt-5 text-sm text-neutral-600">
        <Link href="/cost" className="underline underline-offset-4">
          利用状況（開発確認用）
        </Link>
      </footer>
    </main>
  );
}

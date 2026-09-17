import Link from "next/link";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/app/Header";
import { formatDateTimeJst } from "@/lib/time";
import { MemoryList, type MemoryItem } from "./MemoryList";
import { ExportButton } from "./ExportButton";

/**
 * カッシーに残っている内容の一覧（Phase 3C）。
 *
 * 【2つに分けて見せる】
 * ・いまの内容 … 返事に使われるもの
 * ・昔の考え   … 考えが変わる前のもの。昔のことを聞かれたときだけ使われる
 *
 * 訂正されて無効になった内容と、消した内容は出てこない。
 *
 * 専門用語は出さない（版・状態・idなどは画面に出さない）。
 */
export default async function MemoriesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [current, past] = await Promise.all([
    load(supabase, "confirmed_memories", "confirmed_at", "残した日"),
    load(supabase, "past_memories", "revised_at", "考えが変わった日"),
  ]);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Header backHref="/" />

      <h2 className="mt-8 text-xl font-bold">カッシーに残してある内容</h2>
      <p className="m-0 mt-2 text-base text-neutral-600">
        返事をするときに、カッシーが参考にする内容です。
        <br />
        いらないものは、ここから消せます。
      </p>

      <section className="mt-8">
        <h3 className="m-0 text-lg font-bold">いまの内容（{current.length}件）</h3>
        <MemoryList items={current} emptyMessage="まだ残しているものはありません。" />
      </section>

      <section className="mt-12">
        <h3 className="m-0 text-lg font-bold">昔の考え（{past.length}件）</h3>
        <p className="m-0 mt-2 text-base text-neutral-600">
          考えが変わる前のものです。間違いだったわけではありません。
          <br />
          ふだんの返事には使わず、昔のことを聞かれたときだけ参考にします。
        </p>
        <MemoryList items={past} emptyMessage="昔の考えとして残しているものはありません。" />
      </section>

      {/* 自分のデータを手元へ持っていく（Phase 4B） */}
      <ExportButton />

      <p className="mt-12 text-base text-neutral-600">
        まだ残すかどうか決めていないものは、
        <Link href="/memories/pending" className="underline underline-offset-4">
          確認待ちの記憶
        </Link>
        にあります。
      </p>
    </main>
  );
}

/** 一覧を1つ読む。RLS により、取れるのは本人のぶんだけ */
async function load(
  supabase: SupabaseClient,
  view: "confirmed_memories" | "past_memories",
  dateColumn: "confirmed_at" | "revised_at",
  dateLabel: string,
): Promise<MemoryItem[]> {
  const { data } = await supabase
    .from(view)
    .select(`id, text, conversation_id, ${dateColumn}`)
    .order(dateColumn, { ascending: false })
    .limit(200);

  // view ごとに日付の列名が違うため、読み取りは1か所にまとめる
  const rows = (data ?? []) as unknown as Record<string, string | null>[];
  if (rows.length === 0) return [];

  const convIds = [...new Set(rows.map((r) => r.conversation_id as string))].filter(Boolean);
  const { data: convs } = await supabase
    .from("conversations")
    .select("id, title")
    .in("id", convIds);
  const titleOf = new Map((convs ?? []).map((c) => [c.id as string, (c.title as string) ?? ""]));

  /* 消したときに一緒に消える版の数。本人に削除の範囲を示すため。
     たどるのはDB側（自分の記憶だけ）。 */
  const items = await Promise.all(
    rows.map(async (r) => {
      const { data: chain } = await supabase.rpc("memory_chain", { target: r.id as string });
      const at = r[dateColumn] ?? null;
      return {
        id: r.id as string,
        text: r.text as string,
        dateLabel,
        date: at ? formatDateTimeJst(at) : "",
        versionCount: Array.isArray(chain) && chain.length > 0 ? chain.length : 1,
        conversationId: r.conversation_id as string,
        conversationTitle: titleOf.get(r.conversation_id as string) ?? "",
      } satisfies MemoryItem;
    }),
  );
  return items;
}

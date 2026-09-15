import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { saveProfile, signOut } from "./actions";

/**
 * ログイン後の最小画面（Phase 1）。
 * - 誰でログインしているか
 * - 表示名とメモの保存（iPad の音声入力が保存まで通るかの確認用）
 * - ログアウト
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により、自分の行しか返らない
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, memo, updated_at")
    .eq("id", user.id)
    .maybeSingle();

  const { saved } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <header className="flex items-center justify-between border-b border-line pb-4">
        <h1 className="text-2xl font-bold tracking-wide">AIカッシー</h1>
        <form action={signOut}>
          <button
            type="submit"
            className="min-h-12 rounded border border-line bg-white px-5 text-base hover:bg-neutral-100"
          >
            ログアウト
          </button>
        </form>
      </header>

      <section className="mt-6 text-base">
        <p>
          ログイン中：
          <span className="font-bold">{profile?.display_name || "（表示名なし）"}</span>
        </p>
        <p className="mt-1 text-sm text-neutral-600">{user.email}</p>
      </section>

      {saved === "ok" && (
        <p className="mt-6 border-l-4 border-accent bg-white px-4 py-3" role="status">
          保存しました。
        </p>
      )}
      {saved === "error" && (
        <p className="mt-6 border-l-4 border-red-700 bg-white px-4 py-3" role="alert">
          保存できませんでした。もう一度お試しください。
        </p>
      )}

      <form action={saveProfile} className="mt-8 flex flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className="font-bold">表示名</span>
          <input
            name="display_name"
            type="text"
            defaultValue={profile?.display_name ?? ""}
            maxLength={50}
            autoComplete="nickname"
            className="min-h-14 rounded border border-line bg-white px-4"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="font-bold">メモ（音声入力の動作確認用）</span>
          <span className="text-sm text-neutral-600">
            iPad ではキーボードのマイクボタンを押して話すと、ここに文字が入ります。
          </span>
          <textarea
            name="memo"
            defaultValue={profile?.memo ?? ""}
            rows={8}
            maxLength={2000}
            className="rounded border border-line bg-white px-4 py-3 leading-relaxed"
          />
        </label>

        <button
          type="submit"
          className="min-h-14 rounded bg-accent px-6 text-lg font-bold text-white hover:opacity-90"
        >
          保存する
        </button>
      </form>

      {profile?.updated_at && (
        <p className="mt-4 text-sm text-neutral-600">
          最終保存：{new Date(profile.updated_at).toLocaleString("ja-JP")}
        </p>
      )}
    </main>
  );
}

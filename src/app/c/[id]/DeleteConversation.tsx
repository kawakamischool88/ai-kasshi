"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteConversation } from "@/app/actions";

/**
 * 会話ごとの削除（Phase 3C）。
 *
 * 【「記憶だけ消す」とは別のもの】
 * こちらは会話そのものが消える。その会話から作った記憶も一緒に消える。
 * 何が消えるかを必ず見せてから、もう一度押してもらう。
 */
export function DeleteConversation({
  conversationId,
  memoryCount,
  messageCount,
}: {
  conversationId: string;
  /** この会話から作られた記憶（残したもの・確認待ちを含む）の件数 */
  memoryCount: number;
  messageCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function remove() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteConversation(conversationId);
      if (result.ok) router.push("/");
      else setError(result.message);
    });
  }

  if (!open) {
    return (
      <div className="mt-12 border-t border-line pt-5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-12 text-base text-neutral-600 underline underline-offset-4"
        >
          この会話を消す
        </button>
      </div>
    );
  }

  return (
    <section className="mt-12 rounded-2xl border-2 border-line bg-white px-5 py-5">
      <h2 className="m-0 text-lg font-bold">この会話を消しますか？</h2>

      <div className="mt-3 text-base">
        <p className="m-0">いっしょに消えるもの：</p>
        <ul className="m-0 mt-2 list-disc pl-6">
          <li>この会話のやりとり（{messageCount}件）</li>
          <li>
            この会話から作った記憶（{memoryCount}件）
            {memoryCount > 0 && <>。カッシーはもう参考にしません</>}
          </li>
          <li>この会話の返事に付いていた「参考にした内容」の表示</li>
        </ul>
        <p className="m-0 mt-3">一度消すと、元にはもどせません。</p>
      </div>

      {error && (
        <p className="m-0 mt-3 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={remove}
          disabled={isPending}
          className="min-h-14 flex-1 rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
        >
          {isPending ? "消しています…" : "会話ごと消す"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={isPending}
          className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
        >
          やめる
        </button>
      </div>
    </section>
  );
}

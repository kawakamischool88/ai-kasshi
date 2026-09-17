"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { deleteMemory } from "@/app/actions";

export type MemoryItem = {
  id: string;
  text: string;
  /** 「残した日」または「考えが変わった日」 */
  dateLabel: string;
  date: string;
  /** 消したときに一緒に消える版の数（削除の範囲を本人に示すため） */
  versionCount: number;
  conversationId: string;
  conversationTitle: string;
};

/**
 * 記憶の一覧と、そこからの削除（Phase 3C）。
 *
 * 【なぜ一覧から消せるようにするか】
 * 会話の中で「これを消して」と言っても、AIが対象を見つけられないことがある。
 * そのとき本人が消す手立てがないのは、記憶を預かる道具として問題がある。
 * 一覧からは、対象を自分の目で確かめて確実に消せる。
 *
 * 【必ず範囲を見せてから消す】
 * 押しただけでは消えない。何がいくつ消えるかを見せ、もう一度押してもらう。
 */
export function MemoryList({ items, emptyMessage }: { items: MemoryItem[]; emptyMessage: string }) {
  if (items.length === 0) {
    return (
      <p className="mt-6 rounded-2xl border border-line bg-white px-5 py-6 text-lg">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="m-0 mt-6 flex list-none flex-col gap-5 p-0">
      {items.map((item) => (
        <li key={item.id}>
          <Row item={item} />
        </li>
      ))}
    </ul>
  );
}

function Row({ item }: { item: MemoryItem }) {
  const [mode, setMode] = useState<"view" | "confirm" | "deleted">("view");
  const [removed, setRemoved] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function remove() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteMemory(item.id);
      if (result.ok) {
        setRemoved(result.removed);
        setMode("deleted");
      } else {
        setError(result.message);
      }
    });
  }

  if (mode === "deleted") {
    return (
      <div
        className="flex items-start gap-3 rounded-2xl border-2 border-accent bg-white px-5 py-4"
        role="status"
      >
        <span aria-hidden="true" className="text-2xl leading-none text-accent">
          ✓
        </span>
        <div>
          <p className="m-0 text-lg font-bold">
            カッシーから消しました
            {removed > 1 && <>（以前の内容もふくめて{removed}件）</>}
          </p>
          <p className="m-0 mt-1 text-base text-neutral-600">
            元の会話はそのまま残っています。
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-2xl border-2 border-line bg-white px-5 py-5">
      <p className="m-0 whitespace-pre-wrap text-lg">「{item.text}」</p>

      <p className="m-0 mt-3 text-sm text-neutral-600">
        {item.dateLabel}：{item.date}
      </p>
      <p className="m-0 mt-1 text-sm text-neutral-600">
        元の会話：
        <Link href={`/c/${item.conversationId}`} className="underline underline-offset-4">
          {item.conversationTitle || "（見出しなし）"}
        </Link>
      </p>

      {error && (
        <p className="m-0 mt-3 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {error}
        </p>
      )}

      {mode === "view" ? (
        <button
          type="button"
          onClick={() => setMode("confirm")}
          className="mt-4 min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg"
        >
          この内容を消す
        </button>
      ) : (
        <div className="mt-4 rounded-xl bg-background px-4 py-4">
          <p className="m-0 text-lg font-bold">本当に消しますか？</p>
          <p className="m-0 mt-2 text-base">
            消えるもの：この内容
            {item.versionCount > 1 && <>（直す前の内容もふくめて{item.versionCount}件）</>}
          </p>
          <p className="m-0 mt-1 text-base">元の会話は消えません。そのまま残ります。</p>
          <p className="m-0 mt-1 text-base">一度消すと、元にはもどせません。</p>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={remove}
              disabled={isPending}
              className="min-h-14 flex-1 rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
            >
              {isPending ? "消しています…" : "消す"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("view");
                setError(null);
              }}
              disabled={isPending}
              className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
            >
              やめる
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";

export type SourceMemory = {
  id: string;
  text: string;
  /** 本人が確定した日時（日本時間の文字列） */
  confirmedAt: string;
  /** 元になった会話 */
  conversationId: string;
  /** 元になった会話の見出し */
  conversationTitle: string;
  /** その会話が、いま開いている会話と同じか */
  isSameConversation: boolean;
};

/**
 * 出典の表示（Phase 3B）。
 *
 * AIが**実際に回答へ使った**確定記憶があるときだけ出す。
 * 検索で候補になっただけのものは出さない。
 *
 * 画面には、記憶の文章・本人が確定した日時・元になった会話だけを出す。
 * 内部の番号や、似ている度合いのような専門用語は出さない。
 */
export function MemorySource({ memories }: { memories: SourceMemory[] }) {
  const [open, setOpen] = useState(false);
  if (memories.length === 0) return null;

  return (
    <div className="mt-2 max-w-[85%] self-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-12 items-center gap-2 rounded-xl border border-line bg-white px-4 text-base text-neutral-700"
      >
        <span aria-hidden="true">🧠</span>
        過去に残した内容を参考にしました
        <span aria-hidden="true" className="text-sm">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <ul className="m-0 mt-2 list-none rounded-xl border border-line bg-white p-0">
          {memories.map((m) => (
            <li key={m.id} className="border-b border-line px-4 py-4 last:border-b-0">
              <p className="m-0 text-base">「{m.text}」</p>
              <p className="m-0 mt-2 text-sm text-neutral-600">
                残した日：{m.confirmedAt}
              </p>
              <p className="m-0 mt-1 text-sm text-neutral-600">
                元の会話：
                {m.isSameConversation ? (
                  <span>この会話</span>
                ) : (
                  <Link
                    href={`/c/${m.conversationId}`}
                    className="underline underline-offset-4"
                  >
                    {m.conversationTitle || "（見出しなし）"}
                  </Link>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

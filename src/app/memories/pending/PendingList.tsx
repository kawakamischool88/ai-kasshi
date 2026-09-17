"use client";

import Link from "next/link";
import { MemoryCard } from "@/app/c/[id]/MemoryCard";

export type PendingItem = {
  id: string;
  text: string;
  requested: boolean;
  createdAt: string;
  expiresAt: string;
  conversationId: string;
  conversationTitle: string;
};

/**
 * 確認待ちの記憶の一覧。
 * 判断の部品（［残す］［直す］［残さない］）は会話画面と同じものを使う。
 */
export function PendingList({ items }: { items: PendingItem[] }) {
  return (
    <ul className="m-0 mt-6 flex list-none flex-col gap-6 p-0">
      {items.map((item) => (
        <li key={item.id}>
          <p className="m-0 text-sm text-neutral-600">
            {item.createdAt} の会話から
            {item.conversationTitle && (
              <>
                {" ／ "}
                <Link
                  href={`/c/${item.conversationId}`}
                  className="underline underline-offset-4"
                >
                  {item.conversationTitle}
                </Link>
              </>
            )}
          </p>
          <MemoryCard candidate={{ id: item.id, text: item.text, requested: item.requested }} />
          <p className="m-0 mt-2 text-sm text-neutral-600">
            {item.expiresAt} をすぎると自動でなくなります
          </p>
        </li>
      ))}
    </ul>
  );
}

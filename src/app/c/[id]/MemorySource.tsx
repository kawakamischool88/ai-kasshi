"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * その記憶が、いまどうなっているか（Phase 3C）。
 *   current  … いまも有効な内容
 *   corrected… そのあと訂正された（参照したのは訂正前の内容）
 *   past     … そのあと考えが変わった（参照したのは当時の考え）
 *   deleted  … そのあと本人が削除した（本文は出さない）
 */
export type SourceState = "current" | "corrected" | "past" | "deleted";

export type SourceMemory = {
  id: string;
  /** 記憶の文章。削除されたものは空（本文を残さない） */
  text: string;
  /** 本人が確定した日時（日本時間の文字列）。削除されたものは空 */
  confirmedAt: string;
  state: SourceState;
  /** 消された日時（日本時間の文字列）。消されていなければ空 */
  deletedAt: string;
  /** 訂正・考えの変化のあとの、いまの内容。なければ空 */
  currentText: string;
  /** 元になった会話 */
  conversationId: string;
  /** 元になった会話の見出し */
  conversationTitle: string;
  /** その会話が、いま開いている会話と同じか */
  isSameConversation: boolean;
};

/**
 * 出典の表示（Phase 3B / 3C）。
 *
 * AIが**実際に回答へ使った**確定記憶があるときだけ出す。
 * 検索で候補になっただけのものは出さない。
 *
 * 【あとから直された・消されたとき（Phase 3C）】
 * 過去の回答は、そのときの内容にもとづいて作られている。
 * あとで訂正・削除されても、その回答の文面は変わらない。
 * だから「この回答は当時の内容を参照していた」と分かるようにする。
 * **削除された記憶の本文は、ここに残さない。**
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
              {m.state === "deleted" ? (
                /* 削除された記憶の本文は出さない。
                   残すのは「参考にしたものがあった」「そのあと消された」
                   「いつ消したか」だけ。引用も、中身が分かる題名も残さない。 */
                <>
                  <p className="m-0 text-base text-neutral-700">
                    この返事で参考にした内容は、そのあと削除されました。
                  </p>
                  {m.deletedAt && (
                    <p className="m-0 mt-2 text-sm text-neutral-600">削除した日：{m.deletedAt}</p>
                  )}
                </>
              ) : (
                <>
                  <p className="m-0 text-base">「{m.text}」</p>

                  {m.state === "corrected" && (
                    <p className="m-0 mt-2 rounded-xl bg-background px-3 py-2 text-base text-neutral-700">
                      この返事では、訂正される前の内容を参考にしていました。
                      {m.currentText && (
                        <>
                          <br />
                          いまの内容：「{m.currentText}」
                        </>
                      )}
                    </p>
                  )}

                  {m.state === "past" && (
                    <p className="m-0 mt-2 rounded-xl bg-background px-3 py-2 text-base text-neutral-700">
                      この返事では、当時の考えを参考にしていました。そのあと考えが変わっています。
                      {m.currentText && (
                        <>
                          <br />
                          いまの考え：「{m.currentText}」
                        </>
                      )}
                    </p>
                  )}

                  {m.confirmedAt && (
                    <p className="m-0 mt-2 text-sm text-neutral-600">残した日：{m.confirmedAt}</p>
                  )}
                </>
              )}

              {m.conversationId ? (
                <p className="m-0 mt-1 text-sm text-neutral-600">
                  元の会話：
                  {m.isSameConversation ? (
                    <span>この会話</span>
                  ) : (
                    <Link href={`/c/${m.conversationId}`} className="underline underline-offset-4">
                      {m.conversationTitle || "（見出しなし）"}
                    </Link>
                  )}
                </p>
              ) : (
                <p className="m-0 mt-1 text-sm text-neutral-600">
                  元の会話も、いっしょに消されています。
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

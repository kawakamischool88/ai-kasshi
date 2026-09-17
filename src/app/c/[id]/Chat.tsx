"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { retryLastReply, sendMessage } from "@/app/actions";

type Msg = { id: string; role: "user" | "assistant"; content: string };

/**
 * 会話の画面。
 *
 * ・送信は「送信する」ボタンだけ。Enter では送らない
 *   （音声入力で改行が入っても、意図せず送られないようにするため）
 * ・送信中はボタンを押せなくして、二重送信を防ぐ
 *   （念のため、保存する側でも同じ送信は1回しか受け付けない）
 */
export function Chat({
  conversationId,
  messages,
  needsRetry,
  budgetStopped,
  maxInputChars,
}: {
  conversationId: string;
  messages: Msg[];
  needsRetry: boolean;
  budgetStopped: boolean;
  /** サーバー側の設定（src/config/ai.ts）を受け取る。設定そのものは画面に持ち込まない */
  maxInputChars: number;
}) {
  const [draft, setDraft] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  const boxRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  /**
   * 送信中かどうかを、画面の作り直しを待たずに覚えておく印。
   *
   * isPending だけに頼ると、ボタンを続けて2回押されたとき
   * 2回目がまだ「送信中ではない」と判断してしまい、別々の送信として
   * 2通が保存されてしまう（送信IDが別々になるため、保存側の重複防止も効かない）。
   * ここで即座に鍵をかけて、その取りこぼしをなくす。
   */
  const sendingRef = useRef(false);

  // 新しいやりとりが増えたら一番下へ
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isPending]);

  const tooLong = draft.length > maxInputChars;
  const canSend = draft.trim().length > 0 && !tooLong && !isPending && !budgetStopped;

  function send() {
    const text = draft.trim();
    if (!text || isPending || sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    setPendingText(text);
    const clientRequestId = crypto.randomUUID();

    startTransition(async () => {
      const result = await sendMessage({ conversationId, text, clientRequestId });
      if (result.ok) {
        setDraft("");
      } else {
        setError({ message: result.message, canRetry: result.canRetry });
      }
      setPendingText(null);
      sendingRef.current = false;
      boxRef.current?.focus();
    });
  }

  function retry() {
    if (isPending || sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    startTransition(async () => {
      const result = await retryLastReply(conversationId);
      if (!result.ok) setError({ message: result.message, canRetry: result.canRetry });
      sendingRef.current = false;
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* --- やりとり --- */}
      <div className="flex-1 py-6">
        {messages.length === 0 && !isPending && (
          <p className="text-neutral-600">
            話したいことを、下の欄に入れて「送信する」を押してください。
          </p>
        )}

        <ul className="m-0 flex list-none flex-col gap-6 p-0">
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} />
          ))}

          {isPending && pendingText && <Bubble role="user" content={pendingText} />}

          {isPending && <Bubble role="assistant" content="考えています…" muted />}
        </ul>
        <div ref={bottomRef} />
      </div>

      {/* --- 知らせ --- */}
      {budgetStopped && (
        <p className="mb-4 border-l-4 border-red-700 bg-white px-4 py-4" role="alert">
          今月のAIの利用上限に達したため、新しい返事は止めています。
          <br />
          これまでの会話は、これまで通り読めます。
        </p>
      )}

      {error && (
        <div className="mb-4 border-l-4 border-red-700 bg-white px-4 py-4" role="alert">
          <p className="m-0 text-lg">{error.message}</p>
          {error.canRetry && (
            <button
              type="button"
              onClick={retry}
              disabled={isPending}
              className="mt-3 min-h-12 rounded border border-line bg-white px-5 text-base disabled:opacity-50"
            >
              もう一度試す
            </button>
          )}
        </div>
      )}

      {!error && needsRetry && !isPending && !budgetStopped && (
        <div className="mb-4 border-l-4 border-accent bg-white px-4 py-4" role="status">
          <p className="m-0">返事が届いていません。</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 min-h-12 rounded border border-line bg-white px-5 text-base"
          >
            もう一度試す
          </button>
        </div>
      )}

      {/* --- 入力 --- */}
      <div className="sticky bottom-0 border-t border-line bg-background pt-4 pb-6">
        <label htmlFor="draft" className="block font-bold">
          話したいこと
        </label>
        <p className="m-0 mt-1 text-sm text-neutral-600">
          キーボードのマイクボタンから、声で入れることもできます。送る前に読み返せます。
        </p>
        <textarea
          id="draft"
          ref={boxRef}
          lang="ja"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          disabled={budgetStopped}
          className="mt-2 w-full rounded border border-line bg-white px-4 py-3 leading-relaxed disabled:bg-neutral-100"
        />

        {tooLong && (
          <p className="m-0 mt-2 font-bold text-red-700" role="alert">
            長すぎます。{maxInputChars.toLocaleString("ja-JP")}文字までにしてください（いま
            {draft.length.toLocaleString("ja-JP")}文字）。
          </p>
        )}

        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          className="mt-3 min-h-16 w-full rounded bg-accent px-6 text-xl font-bold text-white disabled:opacity-50"
        >
          {isPending ? "送っています…" : "送信する"}
        </button>
      </div>
    </div>
  );
}

/**
 * 発言の吹き出し。
 *
 * どちらの発言かを、色だけに頼らず3つの手がかりで示す。
 *   1. 位置 … 本人は右寄せ、AIカッシーは左寄せ
 *   2. 形   … 話し手の側の角だけを小さくして、吹き出しの向きを作る
 *   3. 塗り … 本人は塗りつぶし、AIカッシーは白地に太めの枠線
 *
 * 色が見分けにくい方や、白黒で印刷した場合でも区別できる。
 * 「あなた」「AIカッシー」のラベルも残し、吹き出しと同じ側に置く。
 */
function Bubble({
  role,
  content,
  muted = false,
}: {
  role: "user" | "assistant";
  content: string;
  /** 「考えています…」など、本文ではない案内を薄く出すとき */
  muted?: boolean;
}) {
  const mine = role === "user";
  return (
    <li className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <p className="m-0 mb-1 px-2 text-sm font-bold text-neutral-600">
        {mine ? "あなた" : "AIカッシー"}
      </p>
      <p
        className={[
          "m-0 max-w-[85%] whitespace-pre-wrap px-5 py-4 rounded-2xl",
          mine
            ? // 右下だけ直角にして、右（本人）から出た吹き出しに見せる
              "rounded-br-none bg-accent text-white"
            : // 左下だけ直角にして、左（AIカッシー）から出た吹き出しに見せる
              "rounded-bl-none border-2 border-line bg-white",
          muted ? "text-neutral-600" : "",
        ].join(" ")}
      >
        {content}
      </p>
    </li>
  );
}

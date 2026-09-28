"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * サーバーで処理するボタン（「新しく話す」「ログアウト」）を、1回だけ送る部品。
 *
 * 【なぜ要るのか】
 * サーバーで処理して画面を移るまでの間、何も変わらないと、
 * 「押せていない」と思ってもう一度押してしまう。
 * 「新しく話す」は、二度押すと空の会話が2つできてしまう。
 *
 * 【守り方は「送信する」と同じ】
 *   ① 押した瞬間に鍵をかける（画面の作り直しを待たない）
 *      → 素早く2回押されても、2回目は送らない
 *   ② ボタンを無効化し、文字を「○○しています…」に変える
 *
 * 「送信中かどうか」だけに頼ると、素早い連打で2回送られてしまう
 * （Phase 2 で実際に起きた）。そのため①の鍵まで入れる。
 */
export function SubmitOnce({
  action,
  label,
  pendingLabel,
  className,
}: {
  action: () => Promise<void>;
  label: ReactNode;
  pendingLabel: ReactNode;
  className: string;
}) {
  const lockedRef = useRef(false);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        // 2回目以降は送らない（鍵は、処理が終わってこの部品が残っているときだけ外れる）
        if (lockedRef.current) {
          e.preventDefault();
          return;
        }
        lockedRef.current = true;
      }}
    >
      <SubmitButton
        label={label}
        pendingLabel={pendingLabel}
        className={className}
        onSettled={() => {
          lockedRef.current = false;
        }}
      />
    </form>
  );
}

/** 送信中かどうかは、フォームの中からしか分からないため、ボタンを分けてある */
function SubmitButton({
  label,
  pendingLabel,
  className,
  onSettled,
}: {
  label: ReactNode;
  pendingLabel: ReactNode;
  className: string;
  onSettled: () => void;
}) {
  const { pending } = useFormStatus();
  const wasPending = useRef(false);

  /* 処理が終わったのに、画面を移らずにこの部品が残っている
     （＝うまくいかなかった）ときだけ、鍵を外してもう一度押せるようにする。
     うまくいったときは画面が移るので、この部品ごとなくなる。 */
  useEffect(() => {
    if (wasPending.current && !pending) onSettled();
    wasPending.current = pending;
  }, [pending, onSettled]);

  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : label}
    </button>
  );
}

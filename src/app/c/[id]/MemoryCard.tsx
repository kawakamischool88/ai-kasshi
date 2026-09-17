"use client";

import { useState, useTransition } from "react";
import { confirmMemory, rejectMemory } from "@/app/actions";

export type Candidate = {
  id: string;
  text: string;
  /** 本人がはっきり「覚えておいて」と言って作られた候補か */
  requested: boolean;
};

/**
 * 記憶候補の確認（Phase 3A）。
 *
 * 会話の流れの下に出て、［残す］［直す］［残さない］を選んでもらう。
 * ・「残しました」と出すのは、実際に保存できたときだけ
 * ・保存に失敗したら、その旨をはっきり出す
 * ・押している間はボタンを押せなくして、二重実行を防ぐ
 */
export function MemoryCard({ candidate }: { candidate: Candidate }) {
  const [mode, setMode] = useState<"ask" | "edit" | "saved" | "dismissed">("ask");
  const [draft, setDraft] = useState(candidate.text);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(text?: string) {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmMemory(candidate.id, text);
      // 保存できたときだけ「残しました」に切り替える
      if (result.ok) setMode("saved");
      else setError(result.message);
    });
  }

  function dismiss() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await rejectMemory(candidate.id);
      if (result.ok) setMode("dismissed");
      else setError(result.message);
    });
  }

  // ---------- 残した後 ----------
  if (mode === "saved") {
    return (
      <div
        className="mt-6 flex items-start gap-3 rounded-2xl border-2 border-accent bg-white px-5 py-4"
        role="status"
      >
        <span aria-hidden="true" className="text-2xl leading-none text-accent">
          ✓
        </span>
        <div>
          <p className="m-0 text-lg font-bold">カッシーに残しました</p>
          <p className="m-0 mt-1 text-base">{draft}</p>
        </div>
      </div>
    );
  }

  // ---------- 残さなかった後 ----------
  if (mode === "dismissed") {
    return (
      <p className="mt-6 rounded-2xl border border-line bg-white px-5 py-4 text-neutral-600" role="status">
        残しませんでした。（会話はそのまま残っています）
      </p>
    );
  }

  // ---------- 確認 ----------
  return (
    <section className="mt-6 rounded-2xl border-2 border-line bg-white px-5 py-5">
      <h2 className="m-0 text-lg font-bold">
        {candidate.requested ? "この内容を、カッシーに残しますか？" : "カッシーに残しますか？"}
      </h2>

      {mode === "ask" ? (
        <p className="m-0 mt-3 whitespace-pre-wrap rounded-xl bg-background px-4 py-3 text-lg">
          「{draft}」
        </p>
      ) : (
        <>
          <label htmlFor={`edit-${candidate.id}`} className="mt-3 block text-base">
            残す内容を直してください
          </label>
          <textarea
            id={`edit-${candidate.id}`}
            lang="ja"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            maxLength={500}
            className="mt-2 w-full rounded-xl border border-line bg-background px-4 py-3 leading-relaxed"
          />
        </>
      )}

      {error && (
        <p className="m-0 mt-3 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {mode === "ask" ? (
          <>
            <button
              type="button"
              onClick={() => save()}
              disabled={isPending}
              className="min-h-14 flex-1 rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
            >
              {isPending ? "残しています…" : "残す"}
            </button>
            <button
              type="button"
              onClick={() => setMode("edit")}
              disabled={isPending}
              className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
            >
              直す
            </button>
            <button
              type="button"
              onClick={dismiss}
              disabled={isPending}
              className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
            >
              残さない
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => save(draft)}
              disabled={isPending || !draft.trim()}
              className="min-h-14 flex-1 rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
            >
              {isPending ? "残しています…" : "これで残す"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(candidate.text);
                setMode("ask");
                setError(null);
              }}
              disabled={isPending}
              className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
            >
              やめる
            </button>
          </>
        )}
      </div>
    </section>
  );
}

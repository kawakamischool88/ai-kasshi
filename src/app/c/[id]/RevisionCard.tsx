"use client";

import { useState, useTransition } from "react";
import {
  applyRevision,
  deleteMemoryByRequest,
  dismissRevisionRequest,
} from "@/app/actions";

export type RevisionProposal = {
  id: string;
  /** AIの見立て。最終的にどうするかは本人がボタンで決める */
  intent: "correct" | "update" | "delete";
  /** いまの内容（変更前） */
  currentText: string;
  /** 新しい内容の案。削除のときは空 */
  proposedText: string;
  /** 対象が「考えが変わる前の古い考え」か */
  isPast: boolean;
  /** 消したときに一緒に消える版の数（削除の範囲を本人に示すため） */
  versionCount: number;
};

type Done =
  | { kind: "corrected"; text: string }
  | { kind: "updated"; text: string }
  | { kind: "deleted"; removed: number }
  | { kind: "dismissed" };

/**
 * 記憶の訂正・考えの変化・削除の確認（Phase 3C）。
 *
 * 【ここが押されるまで、記憶は何も変わっていない】
 * AIは対象を探しただけ。決めるのは本人。
 *
 * 【訂正と考えの変化を、本人が選ぶ】
 * AIの見立てだけで決めない。
 * 「内容が間違っていた」のか「考えが変わった」のかは、本人にしか分からない。
 * 取り違えると、昔の考えが「間違いだった」ことにされてしまう。
 */
export function RevisionCard({ proposal }: { proposal: RevisionProposal }) {
  const [draft, setDraft] = useState(proposal.proposedText);
  const [editing, setEditing] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isDelete = proposal.intent === "delete";

  function revise(kind: "correction" | "update") {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await applyRevision({ requestId: proposal.id, kind, text: draft });
      if (result.ok) {
        setDone(kind === "correction" ? { kind: "corrected", text: draft } : { kind: "updated", text: draft });
      } else {
        setError(result.message);
      }
    });
  }

  function remove() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteMemoryByRequest(proposal.id);
      if (result.ok) setDone({ kind: "deleted", removed: result.removed });
      else setError(result.message);
    });
  }

  function cancel() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await dismissRevisionRequest(proposal.id);
      if (result.ok) setDone({ kind: "dismissed" });
      else setError(result.message);
    });
  }

  // ---------- 済んだ後 ----------
  if (done) {
    if (done.kind === "dismissed") {
      return (
        <p
          className="mt-6 rounded-2xl border border-line bg-white px-5 py-4 text-neutral-600"
          role="status"
        >
          そのままにしました。（記憶は変わっていません）
        </p>
      );
    }

    if (done.kind === "deleted") {
      return (
        <div
          className="mt-6 flex items-start gap-3 rounded-2xl border-2 border-accent bg-white px-5 py-4"
          role="status"
        >
          <span aria-hidden="true" className="text-2xl leading-none text-accent">
            ✓
          </span>
          <div>
            <p className="m-0 text-lg font-bold">
              カッシーから消しました
              {done.removed > 1 && <>（以前の内容もふくめて{done.removed}件）</>}
            </p>
            <p className="m-0 mt-1 text-base text-neutral-600">
              元の会話はそのまま残っています。
            </p>
          </div>
        </div>
      );
    }

    return (
      <div
        className="mt-6 flex items-start gap-3 rounded-2xl border-2 border-accent bg-white px-5 py-4"
        role="status"
      >
        <span aria-hidden="true" className="text-2xl leading-none text-accent">
          ✓
        </span>
        <div>
          <p className="m-0 text-lg font-bold">
            {done.kind === "corrected" ? "訂正しました" : "いまの考えとして残しました"}
          </p>
          <p className="m-0 mt-1 text-base">{done.text}</p>
          {done.kind === "updated" && (
            <p className="m-0 mt-2 text-base text-neutral-600">
              以前の考えも「昔の考え」として残してあります。
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---------- 削除の確認 ----------
  if (isDelete) {
    return (
      <section className="mt-6 rounded-2xl border-2 border-line bg-white px-5 py-5">
        <h2 className="m-0 text-lg font-bold">この内容を、カッシーから消しますか？</h2>

        <p className="m-0 mt-3 whitespace-pre-wrap rounded-xl bg-background px-4 py-3 text-lg">
          「{proposal.currentText}」
        </p>

        {proposal.isPast && (
          <p className="m-0 mt-2 text-base text-neutral-600">
            これは「昔の考え」として残してあるものです。
          </p>
        )}

        <div className="mt-3 text-base text-neutral-700">
          <p className="m-0">
            消えるもの：この内容
            {proposal.versionCount > 1 && (
              <>（直す前の内容もふくめて{proposal.versionCount}件）</>
            )}
          </p>
          <p className="m-0 mt-1">元の会話は消えません。そのまま残ります。</p>
          <p className="m-0 mt-1">一度消すと、元にはもどせません。</p>
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
            {isPending ? "消しています…" : "消す"}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={isPending}
            className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
          >
            やめる
          </button>
        </div>
      </section>
    );
  }

  // ---------- 訂正・考えの変化の確認 ----------
  /* AIの見立て（intent）は、ボタンの並び順にだけ使う。
     どちらにするかは本人が決める。 */
  const correctionFirst = proposal.intent === "correct";

  const correctionButton = (
    <button
      type="button"
      onClick={() => revise("correction")}
      disabled={isPending || !draft.trim()}
      className="min-h-16 w-full rounded-xl border-2 border-line bg-white px-5 py-3 text-left text-lg disabled:opacity-50"
    >
      <span className="block font-bold">内容が間違っていた（直す）</span>
      <span className="block text-base text-neutral-600">前の内容は使わなくなります</span>
    </button>
  );

  const updateButton = (
    <button
      type="button"
      onClick={() => revise("update")}
      disabled={isPending || !draft.trim()}
      className="min-h-16 w-full rounded-xl border-2 border-line bg-white px-5 py-3 text-left text-lg disabled:opacity-50"
    >
      <span className="block font-bold">考えが変わった（今の考えにする）</span>
      <span className="block text-base text-neutral-600">前の考えも「昔の考え」として残します</span>
    </button>
  );

  return (
    <section className="mt-6 rounded-2xl border-2 border-line bg-white px-5 py-5">
      <h2 className="m-0 text-lg font-bold">この内容を、どうしますか？</h2>

      <p className="m-0 mt-4 text-base font-bold text-neutral-600">いまの内容</p>
      <p className="m-0 mt-1 whitespace-pre-wrap rounded-xl bg-background px-4 py-3 text-lg">
        「{proposal.currentText}」
      </p>

      <p className="m-0 mt-4 text-base font-bold text-neutral-600">新しい内容</p>
      {editing ? (
        <textarea
          id={`revise-${proposal.id}`}
          lang="ja"
          aria-label="新しい内容"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          maxLength={500}
          className="mt-1 w-full rounded-xl border border-line bg-background px-4 py-3 leading-relaxed"
        />
      ) : (
        <p className="m-0 mt-1 whitespace-pre-wrap rounded-xl bg-background px-4 py-3 text-lg">
          「{draft}」
        </p>
      )}

      {error && (
        <p className="m-0 mt-3 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {correctionFirst ? (
          <>
            {correctionButton}
            {updateButton}
          </>
        ) : (
          <>
            {updateButton}
            {correctionButton}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => {
            setEditing((v) => !v);
            setError(null);
          }}
          disabled={isPending}
          className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
        >
          {editing ? "直すのをやめる" : "文章を直す"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={isPending}
          className="min-h-14 rounded-xl border-2 border-line bg-white px-6 text-lg disabled:opacity-50"
        >
          そのままにする
        </button>
      </div>
    </section>
  );
}

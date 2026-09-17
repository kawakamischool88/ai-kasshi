"use client";

import { useRef, useState } from "react";

type State =
  | { kind: "ready" }
  | { kind: "working" }
  | { kind: "done"; fileName: string }
  | { kind: "error"; message: string };

/**
 * 自分のデータを書き出す（Phase 4B）。
 *
 * 【何度押しても大丈夫】
 * 押している間は、もう一度押せないようにしてある。
 * そもそも書き出しはDBに何も作らないので、押しても記録は増えない。
 *
 * 【専門用語を出さない】
 * 「エクスポート」「ZIP」「JSON」とは書かない。
 */
export function ExportButton() {
  const [state, setState] = useState<State>({ kind: "ready" });
  const workingRef = useRef(false);

  async function run() {
    // 画面の作り直しを待たずに鍵をかける（続けて2回押されても1回だけにする）
    if (workingRef.current) return;
    workingRef.current = true;
    setState({ kind: "working" });

    try {
      const res = await fetch("/api/export", { cache: "no-store" });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setState({
          kind: "error",
          message: body?.message ?? "うまくいきませんでした。もう一度お試しください。",
        });
        return;
      }

      /* 中身がファイルであることを確かめてから保存する。
         何かの手違いで画面のHTMLが返ってきたとき、
         それをファイルとして保存してしまわないように。 */
      if (!res.headers.get("content-type")?.includes("application/zip")) {
        setState({
          kind: "error",
          message: "うまくいきませんでした。一度ログインし直してから、お試しください。",
        });
        return;
      }

      const blob = await res.blob();
      const fileName = readFileName(res.headers.get("content-disposition"));

      // 手元へ保存する（サーバーには何も残らない）
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setState({ kind: "done", fileName });
    } catch {
      setState({
        kind: "error",
        message: "通信がうまくいきませんでした。電波の状態を確かめて、もう一度お試しください。",
      });
    } finally {
      workingRef.current = false;
    }
  }

  return (
    <section className="mt-12 rounded-2xl border-2 border-line bg-white px-5 py-5">
      <h3 className="m-0 text-lg font-bold">自分のデータを書き出す</h3>
      <p className="m-0 mt-2 text-base text-neutral-700">
        AIカッシーに残してある会話や記憶を、自分用のファイルとしてまとめます。
        <br />
        パソコンやiPadに保存しておけます。
      </p>
      <p className="m-0 mt-2 text-base text-neutral-600">
        消した内容は入りません。ほかの人の内容も入りません。
      </p>

      {state.kind === "done" && (
        <div
          className="mt-4 flex items-start gap-3 rounded-xl border-2 border-accent bg-background px-4 py-4"
          role="status"
        >
          <span aria-hidden="true" className="text-2xl leading-none text-accent">
            ✓
          </span>
          <div>
            <p className="m-0 text-lg font-bold">書き出しました</p>
            <p className="m-0 mt-1 text-base">
              「ダウンロード」の中に保存されています。
              <br />
              ほかの人に渡したり、共有フォルダに置いたりしないでください。
            </p>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <p className="m-0 mt-4 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {state.message}
        </p>
      )}

      <button
        type="button"
        onClick={run}
        disabled={state.kind === "working"}
        className="mt-4 min-h-16 w-full rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
      >
        {state.kind === "working"
          ? "まとめています…"
          : state.kind === "done"
            ? "もう一度書き出す"
            : "自分のデータを書き出す"}
      </button>

      {state.kind === "working" && (
        <p className="m-0 mt-3 text-base text-neutral-600" role="status">
          少しお待ちください。会話が多いと時間がかかることがあります。
        </p>
      )}
    </section>
  );
}

/** サーバーが付けたファイル名を読み取る。読めなければ無難な名前にする */
function readFileName(header: string | null): string {
  if (header) {
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf8) {
      try {
        return decodeURIComponent(utf8[1]);
      } catch {
        // 読めないときは下の無難な名前にする
      }
    }
  }
  return "AIカッシー_自分のデータ.zip";
}

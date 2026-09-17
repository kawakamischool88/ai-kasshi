"use client";

import { useRef, useState } from "react";
import { PDF_KEEP_NOTICE, PDF_PERIODS, type PdfPeriod } from "@/config/pdf";

type State =
  | { kind: "ready" }
  | { kind: "working"; period: PdfPeriod }
  | { kind: "done"; label: string }
  | { kind: "error"; message: string };

/**
 * 振り返りPDFを作る（Phase 4C）。
 *
 * 【何度押しても大丈夫】
 * 押している間は押せない。そもそもPDF作りはDBに何も作らない。
 *
 * 【専門用語を出さない】
 * 「PDF」は本人にも通じる言葉なのでそのまま使う。
 * 「エクスポート」「生成」「API」などは使わない。
 */
export function ReviewPdfButton() {
  const [state, setState] = useState<State>({ kind: "ready" });
  const workingRef = useRef(false);

  async function run(period: PdfPeriod, label: string) {
    // 画面の作り直しを待たずに鍵をかける（続けて2回押されても1回だけにする）
    if (workingRef.current) return;
    workingRef.current = true;
    setState({ kind: "working", period });

    try {
      const res = await fetch(`/api/pdf?period=${period}`, { cache: "no-store" });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setState({
          kind: "error",
          message: body?.message ?? "うまくいきませんでした。もう一度お試しください。",
        });
        return;
      }

      /* 中身が本当にPDFかを確かめてから保存する。
         何かの手違いで画面のHTMLが返ってきたとき、
         それをPDFとして保存してしまわないように。 */
      if (!res.headers.get("content-type")?.includes("application/pdf")) {
        setState({
          kind: "error",
          message: "うまくいきませんでした。一度ログインし直してから、お試しください。",
        });
        return;
      }

      const blob = await res.blob();
      const fileName = readFileName(res.headers.get("content-disposition"));

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setState({ kind: "done", label });
    } catch {
      setState({
        kind: "error",
        message: "通信がうまくいきませんでした。電波の状態を確かめて、もう一度お試しください。",
      });
    } finally {
      workingRef.current = false;
    }
  }

  const busy = state.kind === "working";

  return (
    <section className="mt-10 rounded-2xl border-2 border-line bg-white px-5 py-5">
      <h3 className="m-0 text-lg font-bold">振り返りを読む</h3>
      <p className="m-0 mt-2 text-base text-neutral-700">
        その月にカッシーへ残したこと、考えが変わったこと、訂正したことを
        <br />
        一枚の資料にまとめます。印刷してお読みいただけます。
      </p>
      <p className="m-0 mt-2 text-base text-neutral-600">
        確認待ちのもの、残さないと決めたもの、消したものは載りません。
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
            <p className="m-0 text-lg font-bold">{state.label}の振り返りを作りました</p>
            <p className="m-0 mt-1 text-base">
              「ダウンロード」の中に保存されています。
              <br />
              {PDF_KEEP_NOTICE}
            </p>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <p className="m-0 mt-4 border-l-4 border-red-700 bg-background px-4 py-3" role="alert">
          {state.message}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {PDF_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => run(p.key, p.label)}
            disabled={busy}
            className="min-h-16 w-full rounded-xl bg-accent px-6 text-lg font-bold text-white disabled:opacity-50"
          >
            {busy && state.period === p.key
              ? "作っています…"
              : `${p.label}の振り返りを作る`}
          </button>
        ))}
      </div>

      {busy && (
        <p className="m-0 mt-3 text-base text-neutral-600" role="status">
          少しお待ちください。
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
  return "AIカッシー_振り返り.pdf";
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PdfPeriod } from "@/config/pdf";
import { collectPdfContent, pdfSnapshot } from "./collect";
import { pdfHasForbidden, renderPdf } from "./render";

/**
 * 振り返りPDFを作る（Phase 4C）。
 *
 * 【作っている最中に変わったら渡さない】
 * 作り始めと作り終わりで、記憶の状態を見比べる。
 * 消された・直された・考えが変わっていたら、**古い内容のPDFは渡さない**。
 * 回答を作るとき（Phase 3D）・書き出し（Phase 4B）と同じ考え方。
 *
 * 【AIを使わない】
 * この処理の中でAIは一度も呼ばない。
 * だから、月のAI利用が停止していてもPDFは作れる。
 */

export type PdfResult =
  | { ok: true; pdf: Uint8Array; fileName: string; summary: PdfSummary }
  | { ok: false; reason: "changed" | "forbidden" | "failed"; message: string };

export type PdfSummary = {
  periodLabel: string;
  kept: number;
  changed: number;
  corrected: number;
  isEmpty: boolean;
  bytes: number;
  durationMs: number;
};

export async function buildPdf(
  supabase: SupabaseClient,
  userId: string,
  period: PdfPeriod,
  now = new Date(),
): Promise<PdfResult> {
  const startedAt = Date.now();

  try {
    // --- 作り始めの状態を控える ---
    const before = await pdfSnapshot(supabase, userId);

    const content = await collectPdfContent(supabase, userId, period, now);
    const pdf = await renderPdf(content, now);

    // --- 入ってはいけない語が混ざっていないか ---
    const forbidden = pdfHasForbidden(pdf);
    if (forbidden) {
      console.error(`[振り返りPDF] 入れてはいけない文字が混ざっています：${forbidden}`);
      return {
        ok: false,
        reason: "forbidden",
        message: "PDFを作れませんでした。管理者にお知らせください。",
      };
    }

    // --- 作っている間に、本人が消したり直したりしていないか ---
    const after = await pdfSnapshot(supabase, userId);
    if (before !== after) {
      return {
        ok: false,
        reason: "changed",
        message:
          "PDFを作っている間に、記録の内容が変わりました。" +
          "古い内容のPDFはお渡ししません。もう一度お試しください。",
      };
    }

    return {
      ok: true,
      pdf,
      fileName: `AIカッシー_振り返り_${fileStamp(content.start)}.pdf`,
      summary: {
        periodLabel: content.periodLabel,
        kept: content.kept.length,
        changed: content.changed.length,
        corrected: content.corrected.length,
        isEmpty: content.isEmpty,
        bytes: pdf.length,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (e) {
    console.error("[振り返りPDF] 想定外のエラー:", e);
    return {
      ok: false,
      reason: "failed",
      message: "PDFを作れませんでした。もう一度お試しください。",
    };
  }
}

/** ファイル名用の「2026年09月」 */
function fileStamp(start: Date): string {
  const jst = new Date(start.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${String(jst.getUTCMonth() + 1).padStart(2, "0")}月`;
}

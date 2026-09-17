import type { SupabaseClient } from "@supabase/supabase-js";
import { PDF_ALLOWED_ORIGINS, type PdfPeriod } from "@/config/pdf";
import { monthRangeJst, formatDayJst } from "@/lib/time";

/**
 * 振り返りPDFに載せる内容を集める（Phase 4C）。
 *
 * 【載せるのは、本人が確定したものだけ】
 * 確認待ち・残さないと決めたもの・期限切れ・消したものは、
 * **1件も混ぜない**。DBから読む段階で外す。
 *
 * 【ほかの人のものが混ざらない作り】
 * 渡すのは**ログイン中の本人の接続**。DBの決まり（RLS）で他人の行は返らない。
 * その上で user_id の条件も書く（二重の守り）。
 *
 * 【AIを使わない】
 * 本人が確定した文章を、そのまま並べる。要約も言い換えもしない。
 */

export type PdfMemory = {
  /** 本人が確定した文章（そのまま） */
  text: string;
  /** 情報の由来 */
  origin: string;
  /** 本人が確定した日（日本時間） */
  confirmedOn: string;
  /** 元の会話の見出し */
  conversationTitle: string;
};

export type PdfRevision = {
  /** 直す前の内容 */
  before: string;
  /** いまの内容 */
  after: string;
  /** 直した日（日本時間） */
  revisedOn: string;
  /** いまの内容の由来 */
  origin: string;
  conversationTitle: string;
};

export type PdfContent = {
  periodLabel: string;
  start: Date;
  end: Date;
  /** その期間に確定した、いま有効な記憶 */
  kept: PdfMemory[];
  /** その期間に考えが変わったもの */
  changed: PdfRevision[];
  /** その期間に訂正したもの */
  corrected: PdfRevision[];
  /** 何も無かったか */
  isEmpty: boolean;
};

/** PDFを作り始めた時点の控え（作り終わりに見比べる） */
export type PdfSnapshot = string;

type Row = Record<string, unknown>;

/**
 * いま有効な記憶の状態を控える。
 *
 * PDFを作っている間に本人が消したり直したりしたら、
 * 古い内容のPDFを渡さないため（Phase 3D・4B と同じ考え方）。
 */
export async function pdfSnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<PdfSnapshot> {
  const { data, error } = await supabase
    .from("memory_candidates")
    .select("id, status, version, confirmed_at, revised_at, deleted_at")
    .eq("user_id", userId)
    .order("id");
  if (error) throw new Error("いまの状態を確かめられませんでした");
  return JSON.stringify(data);
}

/** 会話の見出しを引く（内部の番号はPDFに出さない） */
async function conversationTitles(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const { data } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("user_id", userId)
    .in("id", unique);
  return new Map((data ?? []).map((c) => [c.id as string, (c.title as string) || "（見出しなし）"]));
}

export async function collectPdfContent(
  supabase: SupabaseClient,
  userId: string,
  period: PdfPeriod,
  now = new Date(),
): Promise<PdfContent> {
  const { start, end, label } = monthRangeJst(period === "this" ? 0 : -1, now);

  /* --- その期間に確定した、いま有効な記憶 ---
     status = 'confirmed' だけを読む。
     確認待ち・残さない・期限切れ・消したものは、この時点で入ってこない。
     訂正・考えの変化で作られたもの（revision_of がある）は、
     下の「訂正」「考えの変化」で別に扱うので、ここでは外す。 */
  const { data: keptRows, error: e1 } = await supabase
    .from("memory_candidates")
    .select("suggested_text, confirmed_text, origin, confirmed_at, conversation_id")
    .eq("user_id", userId)
    .eq("status", "confirmed")
    .is("revision_of", null)
    .gte("confirmed_at", start.toISOString())
    .lt("confirmed_at", end.toISOString())
    .order("confirmed_at");
  if (e1) throw new Error(e1.message);

  /* --- その期間に直したもの（訂正・考えの変化） ---
     新しい版のほう（revision_of がある・いま有効）を読み、
     直す前の内容を引き当てる。 */
  const { data: revisedRows, error: e2 } = await supabase
    .from("memory_candidates")
    .select("suggested_text, confirmed_text, origin, revised_at, conversation_id, revision_of, revision_kind")
    .eq("user_id", userId)
    .eq("status", "confirmed")
    .not("revision_of", "is", null)
    .gte("revised_at", start.toISOString())
    .lt("revised_at", end.toISOString())
    .order("revised_at");
  if (e2) throw new Error(e2.message);

  const beforeIds = (revisedRows ?? []).map((r) => r.revision_of as string);
  const { data: beforeRows } = beforeIds.length
    ? await supabase
        .from("memory_candidates")
        .select("id, suggested_text, confirmed_text, status")
        .eq("user_id", userId)
        .in("id", beforeIds)
    : { data: [] as Row[] };

  const beforeById = new Map(
    ((beforeRows ?? []) as Row[]).map((r) => [
      r.id as string,
      {
        /* 直す前の本文。消されていれば空になる（消したものは載せない） */
        text: ((r.confirmed_text as string) ?? (r.suggested_text as string) ?? "") as string,
        status: r.status as string,
      },
    ]),
  );

  const titles = await conversationTitles(supabase, userId, [
    ...(keptRows ?? []).map((r) => r.conversation_id as string),
    ...(revisedRows ?? []).map((r) => r.conversation_id as string),
  ]);

  const textOf = (r: Row) =>
    ((r.confirmed_text as string) ?? (r.suggested_text as string) ?? "").trim();

  const kept: PdfMemory[] = ((keptRows ?? []) as Row[])
    // 本人が採用していないAIの提案は載せない
    .filter((r) => (PDF_ALLOWED_ORIGINS as readonly string[]).includes(String(r.origin)))
    .filter((r) => textOf(r).length > 0)
    .map((r) => ({
      text: textOf(r),
      origin: String(r.origin),
      confirmedOn: formatDayJst(r.confirmed_at as string),
      conversationTitle: titles.get(r.conversation_id as string) ?? "",
    }));

  const changed: PdfRevision[] = [];
  const corrected: PdfRevision[] = [];

  for (const r of (revisedRows ?? []) as Row[]) {
    if (!(PDF_ALLOWED_ORIGINS as readonly string[]).includes(String(r.origin))) continue;
    const after = textOf(r);
    if (!after) continue;

    const before = beforeById.get(r.revision_of as string);
    /* 直す前の記憶が消されていたら、この組は載せない。
       「消した内容」をPDFから読み取れるようにしないため。 */
    if (!before || !before.text || before.status === "deleted") continue;

    const item: PdfRevision = {
      before: before.text,
      after,
      revisedOn: formatDayJst(r.revised_at as string),
      origin: String(r.origin),
      conversationTitle: titles.get(r.conversation_id as string) ?? "",
    };
    if (r.revision_kind === "update") changed.push(item);
    else if (r.revision_kind === "correction") corrected.push(item);
  }

  return {
    periodLabel: label,
    start,
    end,
    kept,
    changed,
    corrected,
    isEmpty: kept.length === 0 && changed.length === 0 && corrected.length === 0,
  };
}

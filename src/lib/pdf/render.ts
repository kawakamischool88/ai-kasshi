import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FORBIDDEN_IN_PDF,
  PDF_EXCLUDES,
  PDF_KEEP_NOTICE,
  PDF_LAYOUT as L,
  PDF_ORIGIN_LABEL,
} from "@/config/pdf";
import { formatDateTimeJst } from "@/lib/time";
import type { PdfContent } from "./collect";

/**
 * 振り返りPDFを作る（Phase 4C）。
 *
 * 【AIを使わない】
 * 本人が確定した文章を、そのまま並べるだけ。
 * 要約も、言い換えも、見出しの自動生成もしない。
 * AIに通すと意味が変わるおそれがあり、費用も増え、
 * 「PDFが作れない」と「AIが失敗した」が混ざってしまうため。
 *
 * 【日本語のために：フォントは丸ごと埋め込む】
 * 日本語が入ったフォントをPDFへ埋め込む。
 * 埋め込まないと、開く機械によっては文字化けする。
 *
 * **使った文字だけを抜き出して埋め込む方法（subset）は使わない。**
 * 実際に試したところ、文字の形（グリフ）がごっそり抜け落ち、
 * PDFを開くと**ほとんどの文字が真っ白**になった。
 * 文字を取り出すと正しく読めるので気づきにくく、たちが悪い。
 * ファイルは約1MBになるが、**読めないPDFを渡すよりずっとよい**。
 *
 * 【太字を使わない理由】
 * フォントを丸ごと埋め込むため、太字を足すとファイルが倍になる。
 * 見出しは、大きさ・色・下線・帯で十分に見分けられる。
 */

const FONT_DIR = path.join(process.cwd(), "src", "assets", "fonts");

/** 文字色（黒だときつく見えるので、少し落とす） */
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const LINE = rgb(0.78, 0.8, 0.84);
/** 見出しの後ろに敷く薄い帯 */
const BAND = rgb(0.93, 0.94, 0.96);
const ACCENT = rgb(0.11, 0.22, 0.4);

/** 行の先頭に置かない文字（日本語の決まり） */
const NO_LINE_START = "、。，．）］｝」』〉》〕！？ー―‐・：；ゝゞヽヾっゃゅょァィゥェォッャュョ%％";
/** 行の末尾に置かない文字 */
const NO_LINE_END = "（［｛「『〈《〔";

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  pageNumber: number;
  pages: PDFPage[];
};

export async function renderPdf(content: PdfContent, now = new Date()): Promise<Uint8Array> {
  const regularBytes = await readFile(path.join(FONT_DIR, "MPLUS1p-Regular.ttf"));

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  /* subset: false（丸ごと埋め込む）。
     使った文字だけにすると、文字の形が抜け落ちて真っ白になる（上の説明のとおり）。 */
  const regular = await doc.embedFont(regularBytes, { subset: false });

  doc.setTitle(`AIカッシー 振り返り ${content.periodLabel}`);
  doc.setCreator("AIカッシー Ver.0.1");
  doc.setProducer("AIカッシー Ver.0.1");
  doc.setCreationDate(now);

  const ctx: Ctx = {
    doc,
    page: doc.addPage([L.pageWidth, L.pageHeight]),
    y: L.pageHeight - L.margin,
    regular,
    pageNumber: 1,
    pages: [],
  };
  ctx.pages.push(ctx.page);

  // ---------- 表紙の見出し ----------
  drawText(ctx, "AIカッシー 振り返り", { size: L.titleSize, color: ACCENT });
  gap(ctx, 6);
  drawText(ctx, content.periodLabel, { size: L.periodSize, color: MUTED });
  drawText(ctx, `作成日時：${formatDateTimeJst(now)}`, { size: L.noteSize, color: MUTED });
  gap(ctx, 10);
  rule(ctx);
  gap(ctx, 14);

  if (content.isEmpty) {
    drawWrapped(ctx, "この期間に、カッシーへ残した内容はありませんでした。", {
      size: L.bodySize,
    });
    gap(ctx, 8);
    drawWrapped(
      ctx,
      "会話をして「カッシーに残す」を選ぶと、次からここに出てきます。",
      { size: L.noteSize, color: MUTED },
    );
  } else {
    // ---------- 残したこと ----------
    if (content.kept.length > 0) {
      section(ctx, `${sectionPrefix(content)}カッシーに残したこと`);
      content.kept.forEach((m, i) => {
        item(ctx, `${i + 1}. 「${m.text}」`);
        meta(ctx, `残した日：${m.confirmedOn}`);
        meta(ctx, PDF_ORIGIN_LABEL[m.origin] ?? m.origin);
        if (m.conversationTitle) meta(ctx, `元の会話：${m.conversationTitle}`);
        gap(ctx, 10);
      });
      gap(ctx, 8);
    }

    // ---------- 変わった考え ----------
    if (content.changed.length > 0) {
      section(ctx, `${sectionPrefix(content)}変わった考え`);
      for (const r of content.changed) {
        meta(ctx, "以前");
        item(ctx, `「${r.before}」`);
        gap(ctx, 2);
        meta(ctx, "↓");
        gap(ctx, 2);
        meta(ctx, "現在");
        item(ctx, `「${r.after}」`);
        gap(ctx, 4);
        meta(ctx, `考えが変わった日：${r.revisedOn}`);
        if (r.conversationTitle) meta(ctx, `元の会話：${r.conversationTitle}`);
        note(ctx, "※ 以前の考えが間違いだったという意味ではありません。");
        gap(ctx, 12);
      }
      gap(ctx, 8);
    }

    // ---------- 訂正したこと ----------
    if (content.corrected.length > 0) {
      section(ctx, `${sectionPrefix(content)}訂正したこと`);
      for (const r of content.corrected) {
        meta(ctx, "訂正前");
        item(ctx, `「${r.before}」`);
        gap(ctx, 2);
        meta(ctx, "↓");
        gap(ctx, 2);
        meta(ctx, "現在");
        item(ctx, `「${r.after}」`);
        gap(ctx, 4);
        meta(ctx, `訂正した日：${r.revisedOn}`);
        if (r.conversationTitle) meta(ctx, `元の会話：${r.conversationTitle}`);
        note(ctx, "※ 訂正前の内容は、現在の回答には使われません。");
        gap(ctx, 12);
      }
    }
  }

  // ---------- 最後の案内 ----------
  gap(ctx, 10);
  rule(ctx);
  gap(ctx, 10);
  drawWrapped(ctx, PDF_KEEP_NOTICE, { size: L.noteSize, color: MUTED });
  gap(ctx, 6);
  drawWrapped(
    ctx,
    "この資料は、読み返すためのものです。カッシーに残してあるものすべてではありません。" +
      "すべてが必要なときは、「自分のデータを書き出す」をお使いください。",
    { size: L.noteSize, color: MUTED },
  );
  gap(ctx, 6);
  drawWrapped(ctx, `この資料に載せていないもの：${PDF_EXCLUDES.map((e) => e.name).join("／")}`, {
    size: L.noteSize,
    color: MUTED,
  });

  // ---------- ページ番号 ----------
  ctx.pages.forEach((p, i) => {
    const label = `${i + 1} / ${ctx.pages.length}`;
    const w = regular.widthOfTextAtSize(label, L.noteSize);
    p.drawText(label, {
      x: L.pageWidth - L.margin - w,
      y: L.margin - 22,
      size: L.noteSize,
      font: regular,
      color: MUTED,
    });
  });

  return doc.save();
}

/** 「今月」「先月」ではなく、月の名前で書く（あとで読み返すため） */
function sectionPrefix(content: PdfContent): string {
  return `${content.periodLabel}に`;
}

// -------------------------------------------------------------
// 描く道具
// -------------------------------------------------------------

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([L.pageWidth, L.pageHeight]);
  ctx.pages.push(ctx.page);
  ctx.pageNumber += 1;
  ctx.y = L.pageHeight - L.margin;
}

/** 書く場所が足りなければ、次のページへ */
function ensure(ctx: Ctx, needed: number) {
  if (ctx.y - needed < L.margin) newPage(ctx);
}

function gap(ctx: Ctx, amount: number) {
  ctx.y -= amount;
}

function rule(ctx: Ctx) {
  ensure(ctx, 10);
  ctx.page.drawLine({
    start: { x: L.margin, y: ctx.y },
    end: { x: L.pageWidth - L.margin, y: ctx.y },
    thickness: 0.8,
    color: LINE,
  });
  ctx.y -= 2;
}

type DrawOptions = { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number };

function drawText(ctx: Ctx, text: string, opt: DrawOptions = {}) {
  const size = opt.size ?? L.bodySize;
  const font = opt.font ?? ctx.regular;
  const lineHeight = size * L.lineHeight;
  ensure(ctx, lineHeight);
  ctx.y -= lineHeight;
  ctx.page.drawText(text, {
    x: L.margin + (opt.indent ?? 0),
    y: ctx.y,
    size,
    font,
    color: opt.color ?? INK,
  });
}

/** 長い文章を、紙の幅で折り返して書く */
function drawWrapped(ctx: Ctx, text: string, opt: DrawOptions = {}) {
  const size = opt.size ?? L.bodySize;
  const font = opt.font ?? ctx.regular;
  const indent = opt.indent ?? 0;
  const maxWidth = L.pageWidth - L.margin * 2 - indent;

  for (const paragraph of text.split("\n")) {
    const lines = wrapJapanese(paragraph, font, size, maxWidth);
    for (const line of lines) {
      drawText(ctx, line, { ...opt, size, font, indent });
    }
  }
}

/**
 * 見出し。
 *
 * 太字を使わないぶん、**薄い帯＋色＋下線**ではっきり見分けられるようにする。
 */
function section(ctx: Ctx, title: string) {
  const size = L.sectionSize;
  const lineHeight = size * L.lineHeight;
  ensure(ctx, lineHeight + 20);
  gap(ctx, 8);

  // 見出しの後ろに薄い帯を敷く
  ctx.page.drawRectangle({
    x: L.margin - 8,
    y: ctx.y - lineHeight - 2,
    width: L.pageWidth - L.margin * 2 + 16,
    height: lineHeight + 6,
    color: BAND,
  });

  drawText(ctx, title, { size, color: ACCENT });
  gap(ctx, 4);
  rule(ctx);
  gap(ctx, 6);
}

/** 本人が確定した文章そのもの。いちばん読みやすくする */
function item(ctx: Ctx, text: string) {
  drawWrapped(ctx, text, { size: L.bodySize, indent: 8 });
}

function meta(ctx: Ctx, text: string) {
  drawWrapped(ctx, text, { size: L.noteSize, color: MUTED, indent: 20 });
}

function note(ctx: Ctx, text: string) {
  drawWrapped(ctx, text, { size: L.noteSize, color: MUTED, indent: 8 });
}

/**
 * 日本語の折り返し。
 *
 * 日本語は語の間に空白がないので、文字ごとに幅を足して折り返す。
 * 行の頭に句読点や閉じカッコが来ないようにする（読みにくいため）。
 */
export function wrapJapanese(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (!text) return [""];

  const lines: string[] = [];
  let line = "";
  let width = 0;

  const widthOf = (ch: string) => {
    try {
      return font.widthOfTextAtSize(ch, size);
    } catch {
      return size; // 測れない文字は、全角ぶんとみなす
    }
  };

  for (const ch of [...text]) {
    const w = widthOf(ch);

    if (width + w > maxWidth && line.length > 0) {
      // 行の頭に来てはいけない文字なら、前の行にぶら下げる
      if (NO_LINE_START.includes(ch)) {
        line += ch;
        lines.push(line);
        line = "";
        width = 0;
        continue;
      }
      // 行の末尾に来てはいけない文字が最後なら、その文字を次の行へ送る
      const last = line.at(-1) ?? "";
      if (NO_LINE_END.includes(last)) {
        line = line.slice(0, -1);
        lines.push(line);
        line = last + ch;
        width = widthOf(last) + w;
        continue;
      }
      lines.push(line);
      line = ch;
      width = w;
      continue;
    }

    line += ch;
    width += w;
  }

  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** 作ったPDFに、入ってはいけない語が混ざっていないか調べる */
export function pdfHasForbidden(bytes: Uint8Array): string | null {
  /* PDFの中身は圧縮されていることがあるので、生のバイト列を文字として見る。
     ここで見つかるのは「圧縮されずに残った文字」だが、
     鍵のような値が平文で紛れ込んでいないかの確認としては有効。 */
  const text = Buffer.from(bytes).toString("latin1");
  for (const word of FORBIDDEN_IN_PDF) {
    if (text.includes(word)) return word;
  }
  return null;
}

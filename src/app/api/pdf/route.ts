import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildPdf } from "@/lib/pdf/build";
import { isPdfPeriod } from "@/config/pdf";

/**
 * 振り返りPDFの受け口（Phase 4C）。
 *
 * 【本人だけが作れる】
 * 誰のぶんかは、**ログインしている本人の情報から決める**。
 * 画面から送られてくるのは「今月か先月か」だけで、
 * 「誰のぶんか」は受け取らないし、使わない。
 *
 * 【サーバーに置かない】
 * 押されたその場で作り、そのまま渡す。サーバーには何も残らない。
 * だから、PDFの置き場所・保存期間・訂正したときの作り直しが要らない。
 *
 * 【AIを使わない】
 * 本人が確定した文章を並べるだけ。
 * したがって、今月のAI利用が停止値に達していてもPDFを作れる。
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { message: "ログインが必要です。" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const raw = request.nextUrl.searchParams.get("period");
  const period = isPdfPeriod(raw) ? raw : "this";

  const result = await buildPdf(supabase, user.id, period);

  if (!result.ok) {
    // 作っている間に内容が変わったときは、409（やり直してもらう）
    const status = result.reason === "changed" ? 409 : 500;
    return NextResponse.json(
      { message: result.message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  const s = result.summary;
  console.log(
    `[振り返りPDF] ${s.periodLabel} 残した${s.kept}・変化${s.changed}・訂正${s.corrected} / ` +
      `${s.bytes} バイト / ${s.durationMs} ミリ秒`,
  );

  return new NextResponse(result.pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      // 日本語のファイル名は RFC 5987 の書き方で渡す
      "content-disposition": `attachment; filename="ai-kasshi-review.pdf"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      "content-length": String(result.pdf.length),
      // 本人のデータなので、どこにも残させない
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

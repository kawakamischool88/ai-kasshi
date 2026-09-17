import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildExport } from "@/lib/export/build";

/**
 * 本人向けデータ書き出しの受け口（Phase 4B）。
 *
 * 【本人だけが取れる】
 * 誰のデータを出すかは、**ログインしている本人の情報から決める**。
 * 画面から送られてきた「誰のぶんか」は受け取らないし、使わない。
 * ログインしていなければ、何も返さない。
 *
 * 【サーバーに置かない】
 * 押されたその場で作り、そのまま渡す。サーバーには何も残らない。
 * 置き場所が無ければ、置きっぱなしの事故も起きない。
 *
 * 【AIを使わない】
 * 本人の原データをそのまま出すだけなので、AIは呼ばない。
 * したがって、今月のAI利用が停止値に達していても書き出せる。
 */
export async function GET() {
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

  const result = await buildExport(supabase, user.id);

  if (!result.ok) {
    // 作っている間に内容が変わったときは、409（やり直してもらう）
    const status = result.reason === "changed" ? 409 : 500;
    return NextResponse.json(
      { message: result.message },
      { status, headers: { "cache-control": "no-store" } },
    );
  }

  console.log(
    `[書き出し] ${result.summary.bytes} バイト / ${result.summary.durationMs} ミリ秒`,
  );

  return new NextResponse(result.zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      // 日本語のファイル名は RFC 5987 の書き方で渡す
      "content-disposition": `attachment; filename="ai-kasshi-export.zip"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
      "content-length": String(result.zip.length),
      // 本人のデータなので、どこにも残させない
      "cache-control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

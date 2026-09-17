import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions } from "./cookies";

/** ログインなしで開けるページ */
const PUBLIC_PATHS = ["/login"];

/**
 * すべてのリクエストでセッションを更新し、
 * 未ログインなら /login へ、ログイン済みで /login に来たら / へ送る。
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, cookieOptions(options)),
          );
        },
      },
    },
  );

  // getSession ではなく getUser を使う（サーバーで署名を検証するため）
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    /* 画面ではないやりとり（/api/…）は、ログイン画面へ送らない。
       ログイン画面のHTMLが「ファイル」として返ってしまい、
       受け取る側が中身を取り違えるおそれがあるため。
       それぞれの受け口が「ログインが必要です」と短く返す。 */
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { message: "ログインが必要です。" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

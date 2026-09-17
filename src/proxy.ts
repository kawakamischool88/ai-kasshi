import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isRestoreMode, RESTORE_ALLOWED_PATHS } from "@/config/mode";

/**
 * Next.js 16 では middleware.ts の代わりに proxy.ts を使う。
 * 静的ファイル以外のすべてのページで、ログイン状態を確認する。
 */
export async function proxy(request: NextRequest) {
  /* 復元した直後の環境は、確認が終わるまで誰も使えないようにする（Phase 4A）。
     ログインの手前で止めるので、画面もサーバー処理も動かない。 */
  if (isRestoreMode()) {
    const path = request.nextUrl.pathname;
    const allowed = RESTORE_ALLOWED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
    if (!allowed) {
      const url = request.nextUrl.clone();
      url.pathname = "/maintenance";
      url.search = "";
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

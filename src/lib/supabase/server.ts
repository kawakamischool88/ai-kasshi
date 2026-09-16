import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cookieOptions } from "./cookies";

/**
 * サーバー側（Server Component / Server Action）の Supabase クライアント。
 *
 * ログイン中の利用者の Cookie を使って動くため、
 * DB 側の RLS がそのまま効く（他人の行は見えない・触れない）。
 * ここでも anon キーしか使わない。service_role は使わない。
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, cookieOptions(options)),
            );
          } catch {
            // Server Component からは Cookie を書けない場合がある。
            // その場合は proxy.ts 側がセッションを更新するので無視してよい。
          }
        },
      },
    },
  );
}

import { createBrowserClient } from "@supabase/ssr";

/**
 * ブラウザ側の Supabase クライアント。
 * 公開してよい anon キーだけを使う。service_role はここに絶対に入れない。
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

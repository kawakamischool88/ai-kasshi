import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * ログイン中の本人が管理者（運営）かどうかを、**サーバー側で**確かめる。
 *
 * 【なぜクライアントに聞かないのか】
 * 「あなたは管理者ですか」を画面から送らせると、送る内容はいくらでも書き換えられる。
 * だから role も user_id も**受け取らない**。
 * 判定に使うのは、Cookie のセッションから DB が読み取る auth.uid() だけ。
 *
 * 【なぜメールアドレスで判定しないのか】
 * 「このメールアドレスなら管理者」を画面側に書くと、
 * 画面を通らない経路（APIの直叩き）が素通りになる。
 * 権限は DB の列（profiles.role）に持たせ、RLS からも同じ判定を使う。
 *
 * 【失敗したときは管理者ではない扱いにする】
 * 通信や権限で失敗したときに「たぶん管理者だろう」と倒すと、
 * 一度の不具合が運営情報の漏れになる。迷ったら見せない。
 */
export async function isAdmin(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_admin");

  if (error) {
    console.error("[admin] 権限の確認に失敗:", error);
    return false;
  }
  return data === true;
}

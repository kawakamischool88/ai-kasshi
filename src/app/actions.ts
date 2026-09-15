"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * 表示名とメモを保存する。
 *
 * 「誰の行を更新するか」は、フォームの値ではなく
 * ログイン情報（auth.getUser）から決める。
 * フォームに user_id を入れても無視される設計。
 */
export async function saveProfile(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const displayName = String(formData.get("display_name") ?? "")
    .trim()
    .slice(0, 50);
  const memo = String(formData.get("memo") ?? "").slice(0, 2000);

  const { error } = await supabase
    .from("profiles")
    .update({ display_name: displayName, memo })
    .eq("id", user.id); // RLS でも同じ条件が掛かるため、二重に守られている

  if (error) {
    // 利用者には短く伝える。詳細はサーバーのログに残す
    console.error("[saveProfile]", error);
    redirect("/?saved=error");
  }

  revalidatePath("/");
  redirect("/?saved=ok");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

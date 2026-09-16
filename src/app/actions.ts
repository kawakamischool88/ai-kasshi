"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { AI } from "@/config/ai";
import { chat, friendlyMessage, type ChatTurn } from "@/lib/ai/anthropic";
import { estimateCostUsd, EMPTY_USAGE, type UsageCounts } from "@/lib/ai/cost";
import { getBudgetStatus } from "@/lib/ai/budget";

/**
 * 【この画面の約束】
 * ・行の持ち主（user_id）は必ず auth.getUser() から決める。
 *   画面から送られてきた user_id は受け取らないし、使わない。
 * ・service_role は使わない。ログイン中の本人の権限だけで読み書きする。
 */

export type SendResult = { ok: true } | { ok: false; message: string; canRetry: boolean };

/** ログイン中の本人を取り出す。未ログインならログイン画面へ送る */
async function requireUser(): Promise<{ supabase: SupabaseClient; userId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, userId: user.id };
}

// =============================================================
// 会話
// =============================================================

/** 新しい会話を作って開く */
export async function createConversation() {
  const { supabase, userId } = await requireUser();

  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[createConversation]", error);
    redirect("/?error=create");
  }

  revalidatePath("/");
  redirect(`/c/${data.id}`);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// =============================================================
// AI利用量の記録
// =============================================================

type UsageRow = {
  userId: string;
  conversationId: string;
  messageId: string | null;
  model: string;
  usage: UsageCounts;
  thinkingTokens: number;
  serviceTier: string | null;
  status: "success" | "error" | "blocked";
  errorCode: string | null;
  durationMs: number | null;
};

/** AI呼び出し1回ぶんを記録する。失敗・停止のときも必ず1行残す */
async function recordUsage(supabase: SupabaseClient, row: UsageRow) {
  const cost = estimateCostUsd(row.model, row.usage);

  const { error } = await supabase.from("ai_usage").insert({
    user_id: row.userId,
    conversation_id: row.conversationId,
    message_id: row.messageId,
    operation_type: "chat",
    provider: AI.provider,
    model: row.model,
    input_tokens: row.usage.input_tokens,
    output_tokens: row.usage.output_tokens,
    cache_creation_5m_tokens: row.usage.cache_creation_5m_tokens,
    cache_creation_1h_tokens: row.usage.cache_creation_1h_tokens,
    cache_read_input_tokens: row.usage.cache_read_input_tokens,
    thinking_tokens: row.thinkingTokens,
    service_tier: row.serviceTier,
    estimated_cost: cost.usd,
    currency: cost.currency,
    pricing_version: cost.version,
    pricing_date: cost.date,
    status: row.status,
    error_code: row.errorCode,
    duration_ms: row.durationMs,
  });

  // 記録に失敗しても会話は止めない。ただしログには必ず残す
  if (error) console.error("[recordUsage] 記録できませんでした:", error);
}

// =============================================================
// 返事をもらう（送信と再試行で共通）
// =============================================================

async function runTurn(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<SendResult> {
  // --- 原価の安全装置。停止値に達していたらAIを呼ばない ---
  const budget = await getBudgetStatus(supabase);
  if (budget.state === "stopped") {
    await recordUsage(supabase, {
      userId,
      conversationId,
      messageId: null,
      model: AI.model,
      usage: EMPTY_USAGE,
      thinkingTokens: 0,
      serviceTier: null,
      status: "blocked",
      errorCode: "budget_stopped",
      durationMs: 0,
    });
    return { ok: false, message: friendlyMessage("budget_stopped"), canRetry: false };
  }

  // --- AIへ渡す文脈は「この会話の直近のやりとり」だけ ---
  const { data: recent, error: historyError } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(AI.contextMessageCount);

  if (historyError) {
    console.error("[runTurn] 会話の読み込みに失敗:", historyError);
    return { ok: false, message: friendlyMessage("api_error"), canRetry: true };
  }

  const history: ChatTurn[] = (recent ?? [])
    .slice()
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  if (history.length === 0 || history[history.length - 1].role !== "user") {
    // 返事をもらう相手の発言がない（再試行の押し間違いなど）
    return { ok: true };
  }

  // --- 呼び出し ---
  const result = await chat(history);

  if (!result.ok) {
    await recordUsage(supabase, {
      userId,
      conversationId,
      messageId: null,
      model: AI.model,
      usage: EMPTY_USAGE,
      thinkingTokens: 0,
      serviceTier: null,
      status: "error",
      errorCode: result.errorCode,
      durationMs: result.durationMs,
    });
    console.error("[runTurn] AI呼び出し失敗:", result.errorCode, result.detail);
    const canRetry = result.errorCode !== "no_api_key" && result.errorCode !== "auth";
    return { ok: false, message: friendlyMessage(result.errorCode), canRetry };
  }

  // --- 返事を保存 ---
  const { data: saved, error: saveError } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: result.text,
    })
    .select("id")
    .single();

  if (saveError) console.error("[runTurn] 返事の保存に失敗:", saveError);

  await recordUsage(supabase, {
    userId,
    conversationId,
    messageId: saved?.id ?? null,
    model: result.model,
    usage: result.usage,
    thinkingTokens: result.thinkingTokens,
    serviceTier: result.serviceTier,
    status: "success",
    errorCode: null,
    durationMs: result.durationMs,
  });

  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { ok: true };
}

// =============================================================
// 送信
// =============================================================

export async function sendMessage(input: {
  conversationId: string;
  text: string;
  clientRequestId: string;
}): Promise<SendResult> {
  const { supabase, userId } = await requireUser();

  const text = input.text.trim();
  if (!text) return { ok: false, message: friendlyMessage("empty_input"), canRetry: false };
  if (text.length > AI.maxInputChars) {
    return { ok: false, message: friendlyMessage("too_long"), canRetry: false };
  }

  // 会話が自分のものか確かめる（RLSでも守られているが、分かりやすい返事のため）
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("id", input.conversationId)
    .maybeSingle();
  if (!conv) return { ok: false, message: "この会話を開けませんでした。", canRetry: false };

  // --- 発言を保存。二重送信は DB の一意制約で1回だけにする ---
  const { error: insertError } = await supabase.from("messages").insert({
    conversation_id: input.conversationId,
    user_id: userId,
    role: "user",
    content: text,
    client_request_id: input.clientRequestId,
  });

  if (insertError) {
    // 23505 = 同じ client_request_id が既にある＝二重送信。
    // 最初の送信がすでに処理しているので、ここでは何もしない（AIを2回呼ばない）
    if (insertError.code === "23505") {
      revalidatePath(`/c/${input.conversationId}`);
      return { ok: true };
    }
    console.error("[sendMessage] 発言の保存に失敗:", insertError);
    return { ok: false, message: friendlyMessage("api_error"), canRetry: true };
  }

  // 見出しが空なら、最初の発言から作る（AIは呼ばない）
  if (!conv.title) {
    await supabase
      .from("conversations")
      .update({ title: text.slice(0, 30) })
      .eq("id", input.conversationId);
  }

  const result = await runTurn(supabase, userId, input.conversationId);
  revalidatePath(`/c/${input.conversationId}`);
  revalidatePath("/");
  return result;
}

/** 返事がもらえなかったときの「もう一度試す」 */
export async function retryLastReply(conversationId: string): Promise<SendResult> {
  const { supabase, userId } = await requireUser();

  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return { ok: false, message: "この会話を開けませんでした。", canRetry: false };

  const result = await runTurn(supabase, userId, conversationId);
  revalidatePath(`/c/${conversationId}`);
  revalidatePath("/");
  return result;
}

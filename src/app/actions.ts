"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { AI, MEMORY } from "@/config/ai";
import { chat, friendlyMessage, type ChatTurn } from "@/lib/ai/anthropic";
import { estimateCostUsd, EMPTY_USAGE, type UsageCounts } from "@/lib/ai/cost";
import { getBudgetStatus } from "@/lib/ai/budget";
import { extractCandidates } from "@/lib/ai/memory";
import { isSaveRequest } from "@/config/memory-prompt";

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
  /** 何のための呼び出しか。chat＝会話の返事、memory_extract＝記憶候補の抽出 */
  operationType: "chat" | "memory_extract";
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
    operation_type: row.operationType,
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
      operationType: "chat",
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
      operationType: "chat",
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
    operationType: "chat",
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

  /* --- 記憶候補の取り出し（Phase 3A） ---
     会話の返事とは別扱い。ここが失敗しても会話は成功のままにする。
     元になった本人の発言は、いま返事をもらった相手の発言。 */
  const sourceMessageId = await findLastUserMessageId(supabase, conversationId);
  if (sourceMessageId) {
    await extractAndSaveCandidates(supabase, userId, conversationId, sourceMessageId, history);
  }

  return { ok: true };
}

// =============================================================
// 記憶候補（Phase 3A）
// =============================================================

/** この会話でいちばん新しい「本人の発言」のid。候補の出典になる */
async function findLastUserMessageId(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

/**
 * 記憶候補を取り出して保存する。
 *
 * 【失敗しても会話は壊さない】
 * ここで何が起きても例外を外へ出さない。候補が作れなければ、
 * 単に記憶の確認画面が出ないだけで、会話は成功のまま。
 *
 * 【同じ発言から同じ候補を繰り返さない】
 * (source_message_id, candidate_index) に一意制約があるので、
 * 二重実行や再試行で重複した候補は作られない（23505 は無視する）。
 */
async function extractAndSaveCandidates(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  sourceMessageId: string,
  history: ChatTurn[],
) {
  try {
    // すでにこの発言から候補を作っていれば、もう作らない（AIも呼ばない）
    const { data: already } = await supabase
      .from("memory_candidates")
      .select("id")
      .eq("source_message_id", sourceMessageId)
      .limit(1);
    if (already && already.length > 0) return;

    const lastUserText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    const requested = isSaveRequest(lastUserText);

    /* この会話ですでに提案した候補を渡し、同じ内容を蒸し返さないようにする。
       （前のやりとりの内容を何度も候補にすると、本人の確認が煩わしくなる） */
    const { data: past } = await supabase
      .from("memory_candidates")
      .select("suggested_text")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(10);
    const alreadySuggested = (past ?? []).map((r) => r.suggested_text as string);

    const recent = history.slice(-MEMORY.contextMessageCount);
    const result = await extractCandidates(recent, requested, alreadySuggested);

    if (!result.ok) {
      await recordUsage(supabase, {
        userId,
        conversationId,
        messageId: sourceMessageId,
        operationType: "memory_extract",
        model: MEMORY.model,
        usage: EMPTY_USAGE,
        thinkingTokens: 0,
        serviceTier: null,
        status: "error",
        errorCode: result.errorCode,
        durationMs: result.durationMs,
      });
      console.error("[記憶候補] 取り出しに失敗:", result.errorCode, result.detail);
      return; // 会話は成功のまま
    }

    await recordUsage(supabase, {
      userId,
      conversationId,
      messageId: sourceMessageId,
      operationType: "memory_extract",
      model: result.model,
      usage: result.usage,
      thinkingTokens: result.thinkingTokens,
      serviceTier: result.serviceTier,
      status: "success",
      errorCode: null,
      durationMs: result.durationMs,
    });

    let candidates = result.candidates;

    /* 本人がはっきり「覚えておいて」と言ったのに何も出てこなかったときは、
       本人の言葉そのものを候補にする（黙って何もしないことは避ける）。 */
    if (requested && candidates.length === 0 && lastUserText.trim()) {
      console.warn("[記憶候補] 保存の希望があったが候補が0件。本人の発言をそのまま候補にする");
      candidates = [
        {
          text: lastUserText.trim().slice(0, 200),
          origin: "self_experience",
          reason: "本人が保存を希望したが、取り出しで候補が作れなかったため本人の発言をそのまま使用",
        },
      ];
    }

    if (candidates.length === 0) return;

    const expiresAt = new Date(Date.now() + MEMORY.expireDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = candidates.slice(0, MEMORY.maxCandidates).map((c, i) => ({
      user_id: userId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      candidate_index: i + 1,
      suggested_text: c.text,
      origin: c.origin,
      requested_by_user: requested,
      status: "pending",
      expires_at: expiresAt,
      extraction_reason: c.reason,
    }));

    const { error } = await supabase.from("memory_candidates").insert(rows);
    if (error && error.code !== "23505") {
      // 23505 = 同じ発言から既に候補がある（二重実行）。それ以外は記録に残す
      console.error("[記憶候補] 保存に失敗:", error);
    }
  } catch (e) {
    console.error("[記憶候補] 想定外のエラー（会話は成功のまま）:", e);
  }
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

// =============================================================
// 記憶候補への本人の判断（［残す］［直す］［残さない］）
// =============================================================

export type MemoryResult = { ok: true } | { ok: false; message: string };

/**
 * 期限切れの候補に印を付ける。
 *
 * 定期実行の仕組みがないため、候補を表示する画面を開いたときに合わせて行う。
 * 対象がなければ何も起きない。閲覧しても期限は延びない。
 */
export async function expireOldCandidates(supabase: SupabaseClient) {
  const { error } = await supabase
    .from("memory_candidates")
    .update({ status: "expired" })
    .eq("status", "pending")
    .lte("expires_at", new Date().toISOString());
  if (error) console.error("[記憶候補] 期限切れの更新に失敗:", error);
}

/**
 * ［残す］／［これで残す］。
 *
 * editedText を渡すと、本人が直した文章で確定する。
 *
 * 【確定できる条件】更新の条件に直接書いてあるため、DB側で守られる。
 *   ・自分の候補であること（RLS）
 *   ・まだ本人確認待ちであること
 *   ・期限が切れていないこと
 * 条件に合わなければ0件更新となり、「残しました」とは表示しない。
 */
export async function confirmMemory(id: string, editedText?: string): Promise<MemoryResult> {
  const { supabase, userId } = await requireUser();

  const text = editedText?.trim();
  if (editedText !== undefined && !text) {
    return { ok: false, message: "残す内容を入力してください。" };
  }
  if (text && text.length > 500) {
    return { ok: false, message: "長すぎます。500文字までにしてください。" };
  }

  const { data, error } = await supabase
    .from("memory_candidates")
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      // 直していないときは、提案された文章をそのまま確定文として残す
      confirmed_text: text ?? undefined,
    })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id, conversation_id");

  if (error) {
    console.error("[記憶候補] 確定に失敗:", error);
    return { ok: false, message: "うまく残せませんでした。もう一度お試しください。" };
  }
  if (!data || data.length === 0) {
    // 期限切れ・すでに判断済み・他人の候補のいずれか
    return { ok: false, message: "この内容はもう残せません。期限が切れているかもしれません。" };
  }

  /* ここで画面を作り直さない。
     作り直すと、確認待ちでなくなった候補の表示が消え、
     「カッシーに残しました」が本人に見えないまま終わってしまうため。
     次に画面を開いたときには、確認済みとして出てこない。 */
  return { ok: true };
}

/** ［残さない］。会話そのものは消さない */
export async function rejectMemory(id: string): Promise<MemoryResult> {
  const { supabase, userId } = await requireUser();

  const { data, error } = await supabase
    .from("memory_candidates")
    .update({ status: "rejected", confirmed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id, conversation_id");

  if (error) {
    console.error("[記憶候補] 却下に失敗:", error);
    return { ok: false, message: "うまく処理できませんでした。もう一度お試しください。" };
  }
  if (!data || data.length === 0) {
    return { ok: false, message: "この内容はもう処理できません。" };
  }

  // 確定のときと同じ理由で、ここでも画面を作り直さない
  return { ok: true };
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { AI, MEMORY, REVISE, SEARCH } from "@/config/ai";
import { chat, friendlyMessage, type ChatTurn } from "@/lib/ai/anthropic";
import { estimateCostUsd, EMPTY_USAGE, type UsageCounts } from "@/lib/ai/cost";
import { getBudgetStatus } from "@/lib/ai/budget";
import { extractCandidates } from "@/lib/ai/memory";
import { isSaveRequest } from "@/config/memory-prompt";
import { asksAboutPast, detectRevisionIntent } from "@/config/revision-prompt";
import { findRevisionTargets } from "@/lib/ai/memory-revise";
import {
  searchMemories,
  fetchUsedMemoriesInConversation,
  keepStillUsable,
  memoriesUnchanged,
  snapshotOf,
  type Memory,
} from "@/lib/ai/memory-search";

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
  /** 何のための呼び出しか。
      chat＝会話の返事、memory_extract＝記憶候補の抽出、memory_search＝関係する記憶の選び出し、
      memory_revise＝訂正・変化・削除の対象探し */
  operationType: "chat" | "memory_extract" | "memory_search" | "memory_revise";
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

/**
 * 有料のAI処理を始める前に、毎回ここで止める（Phase 3D）。
 *
 * 【なぜ呼び出しごとに確かめるか】
 * 1往復のあいだに有料の呼び出しが最大4回ある
 * （記憶の検索・会話の返事・記憶候補の取り出し・訂正や削除の対象探し）。
 * 最初に1回だけ確かめる作りだと、その1往復の途中で停止値を超えても
 * 残りの呼び出しが走ってしまう。
 *
 * 止めたときも記録を1行残す（あとで「何回止めたか」が分かるように）。
 */
async function blockedByBudget(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  operationType: UsageRow["operationType"],
  model: string,
  messageId: string | null = null,
): Promise<boolean> {
  const budget = await getBudgetStatus(supabase);
  if (budget.state !== "stopped") return false;

  await recordUsage(supabase, {
    userId,
    conversationId,
    messageId,
    operationType,
    model,
    usage: EMPTY_USAGE,
    thinkingTokens: 0,
    serviceTier: null,
    status: "blocked",
    errorCode: "budget_stopped",
    durationMs: 0,
  });
  return true;
}

async function runTurn(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<SendResult> {
  // --- 原価の安全装置。停止値に達していたらAIを呼ばない ---
  if (await blockedByBudget(supabase, userId, conversationId, "chat", AI.model)) {
    return { ok: false, message: friendlyMessage("budget_stopped"), canRetry: false };
  }

  /* --- いま返事を待っている発言 ---
     ここだけは、あとで「AIへ送らない」印が付いていても必ず送る
     （その発言に答えないと会話が止まってしまうため）。 */
  const { data: latest } = await supabase
    .from("messages")
    .select("id, role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest || latest.role !== "user") {
    // 返事をもらう相手の発言がない（再試行の押し間違いなど）
    return { ok: true };
  }

  /* --- AIへ渡す文脈は「この会話の直近のやりとり」だけ ---

     【Phase 3D】訂正・削除の影響を受けたやりとりは送らない。
     記憶を消しても、会話に残った古い内容が
     **文脈という別の道から**AIに届いてしまうため。
     画面には今まで通り表示される（本人は読み返せる）。 */
  const { data: recent, error: historyError } = await supabase
    .from("messages")
    .select("id, role, content")
    .eq("conversation_id", conversationId)
    .is("excluded_from_ai_at", null)
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

  // いまの発言が印のせいで抜けていたら、最後に足す
  if ((recent ?? []).every((m) => m.id !== latest.id)) {
    history.push({ role: "user", content: latest.content as string });
  }

  /* --- 確定記憶の検索（Phase 3B） ---
     本人の確定記憶だけを対象に、いまの相談に関係するものを選ぶ。
     失敗しても会話は続ける（記憶なしで答える）。 */
  const lastUserText = history[history.length - 1].content;
  /* 「昔はどう考えていた？」と聞かれたときだけ、過去の考えも検索に加える（Phase 3C）。
     ふだんは現在有効な内容だけを見る（昔と今を混ぜないため）。 */
  const wantsPast = asksAboutPast(lastUserText);
  const search = (await blockedByBudget(supabase, userId, conversationId, "memory_search", SEARCH.model))
    ? { selected: [] as Memory[], examined: 0, call: null }
    : await searchMemories(supabase, userId, lastUserText, wantsPast);

  if (search.call) {
    const c = search.call;
    await recordUsage(supabase, {
      userId,
      conversationId,
      messageId: null,
      operationType: "memory_search",
      model: c.ok ? c.model : SEARCH.model,
      usage: c.ok ? c.usage : EMPTY_USAGE,
      thinkingTokens: c.ok ? c.thinkingTokens : 0,
      serviceTier: c.ok ? c.serviceTier : null,
      status: c.ok ? "success" : "error",
      errorCode: c.ok ? null : c.errorCode,
      durationMs: c.durationMs,
    });
    if (!c.ok) console.error("[記憶検索] 失敗（記憶なしで続行）:", c.errorCode, c.detail);
  }

  /* この会話ですでに使った記憶は、引き続き渡す。
     渡さないと、AIが自分の前の発言を「根拠がない」と誤解して
     正しかった内容を訂正してしまう（実際に起きた）。 */
  const alreadyUsed = await fetchUsedMemoriesInConversation(supabase, userId, conversationId);
  const merged: Memory[] = [];
  let injectedChars = 0;
  for (const m of [...alreadyUsed, ...search.selected]) {
    if (merged.some((x) => x.id === m.id)) continue;
    if (injectedChars + m.text.length > SEARCH.injectChars) continue;
    merged.push(m);
    injectedChars += m.text.length;
  }

  /* 渡す直前に、その記憶がいまも使えるかを確かめ直す（Phase 3C）。
     検索してからここへ来るまでの間に、別の画面で削除・訂正が行われていることがある。
     古い検索結果をそのまま渡すと、消したはずの内容が回答に出てしまう。 */
  const injected = await keepStillUsable(supabase, userId, merged);

  // 記憶の検索でちょうど停止値を越えることがあるので、ここでもう一度確かめる
  if (await blockedByBudget(supabase, userId, conversationId, "chat", AI.model)) {
    return { ok: false, message: friendlyMessage("budget_stopped"), canRetry: false };
  }

  /* 返事を作り始めた時点の記憶の控え。
     返事ができたあと、これと突き合わせて「途中で変わっていないか」を確かめる。 */
  const snapshot = snapshotOf(injected);
  const isPastById = new Map(injected.map((m) => [m.id, m.isPast]));

  // --- 呼び出し ---
  const result = await chat(
    history,
    injected.map((m) => ({ id: m.id, text: m.text, isPast: m.isPast })),
  );

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

  /* --- 返事を保存する直前の確かめ（Phase 3D） ---

     AIが返事を作っている数秒のあいだに、本人が別の画面で
     その記憶を消したり直したりしていることがある。
     そのまま保存すると、**消したはずの内容にもとづく返事が残ってしまう**。
     1件でも変わっていたら、この返事は使わない。 */
  if (!(await memoriesUnchanged(supabase, userId, snapshot, isPastById))) {
    /* 呼び出しの費用はかかっているので、記録は残す。
       返事は保存しないため、error_code でその理由を残す。 */
    await recordUsage(supabase, {
      userId,
      conversationId,
      messageId: null,
      operationType: "chat",
      model: result.model,
      usage: result.usage,
      thinkingTokens: result.thinkingTokens,
      serviceTier: result.serviceTier,
      status: "success",
      errorCode: "memory_changed_discarded",
      durationMs: result.durationMs,
    });
    console.warn("[runTurn] 返事の作成中に記憶が変わったため、この返事は使いません");
    return {
      ok: false,
      message:
        "参考にしていた内容が途中で変更されたため、この返事は使いませんでした。もう一度お試しください。",
      canRetry: true,
    };
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

  /* --- 出典の記録（Phase 3B） ---
     渡した記憶のうち、AIが**実際に使った**と申告したものだけを記録する。
     渡しただけのものを出典にすると、本人に嘘を伝えることになる。 */
  if (saved?.id && result.usedMemoryNumbers.length > 0) {
    await recordMemoryReferences(supabase, userId, saved.id, injected, result.usedMemoryNumbers);
  }

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


    /* --- 訂正・考えの変化・削除の対象探し（Phase 3C） ---
       「それ違うよ」「○○の記憶を消して」等と言われたときだけ走る。
       ここで作るのは**本人への提案だけ**で、記憶は何も書き換わらない。 */
    await findAndSaveRevisionRequests(
      supabase,
      userId,
      conversationId,
      sourceMessageId,
      lastUserText,
    );
  }

  return { ok: true };
}

// =============================================================
// 出典の記録（Phase 3B）
// =============================================================

/**
 * AIが実際に使ったと申告した記憶だけを、出典として記録する。
 *
 * 番号は「回答へ渡した記憶の並び順」。渡していない番号は捨てる。
 * ここが失敗しても会話は壊さない（出典が出ないだけ）。
 */
async function recordMemoryReferences(
  supabase: SupabaseClient,
  userId: string,
  messageId: string,
  injected: Memory[],
  usedNumbers: number[],
) {
  try {
    const ids = new Set<string>();
    for (const n of usedNumbers) {
      const m = injected[n - 1];
      if (m) ids.add(m.id);
    }
    if (ids.size === 0) return;

    const rows = [...ids].map((memoryId) => ({
      user_id: userId,
      message_id: messageId,
      memory_id: memoryId,
    }));
    const { error } = await supabase.from("memory_references").insert(rows);
    if (error && error.code !== "23505") console.error("[出典] 記録に失敗:", error);
  } catch (e) {
    console.error("[出典] 想定外のエラー（会話は成功のまま）:", e);
  }
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

    /* この発言から作った記憶を、本人が削除していないか確かめる（Phase 3C）。
       元の会話は残るので、何もしないと同じ発言から同じ記憶が
       ふたたび作られてしまう（消したはずの内容の復活）。

       候補の行そのものも残る（本文を消して deleted にする）ので、
       上の「すでに候補がある」判定と、DBの一意の決まりでも止まる。
       ここはその3つ目の備え。 */
    const { data: deleted } = await supabase
      .from("memory_deletions")
      .select("id")
      .eq("source_message_id", sourceMessageId)
      .limit(1);
    if (deleted && deleted.length > 0) {
      console.warn("[記憶候補] この発言から作った記憶は削除済みのため、作り直さない");
      return;
    }

    // 有料の呼び出しの前に、毎回止める（Phase 3D）
    if (await blockedByBudget(supabase, userId, conversationId, "memory_extract", MEMORY.model, sourceMessageId)) {
      return;
    }

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

// =============================================================
// 記憶の訂正・考えの変化・削除（Phase 3C）
//
// 【いちばん大事な決まり】
// AIができるのは「これのことですか？」と提案するところまで。
// 記憶が実際に変わるのは、本人がこの下のボタンを押したときだけ。
// =============================================================

/**
 * 「それ違うよ」「○○の記憶を消して」等の発言から、対象の記憶を探して提案を作る。
 *
 * 【ここでは何も書き換えない】
 * 作るのは memory_revision_requests（提案）だけ。
 * 記憶そのものには一切手を触れない。
 *
 * 【失敗しても会話は壊さない】
 * ここで何が起きても例外を外へ出さない。提案が作れなければ、
 * 単に確認のカードが出ないだけで、会話は成功のまま。
 */
async function findAndSaveRevisionRequests(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  sourceMessageId: string,
  utterance: string,
) {
  try {
    /* まず言葉で絞る。手がかりがなければAIを呼ばない
       （ふだんの会話に余計な費用をかけないため）。 */
    if (!detectRevisionIntent(utterance)) return;

    // すでにこの発言から提案を作っていれば、もう作らない（二重実行・再試行の対策）
    const { data: already } = await supabase
      .from("memory_revision_requests")
      .select("id")
      .eq("source_message_id", sourceMessageId)
      .limit(1);
    if (already && already.length > 0) return;

    // 有料の呼び出しの前に、毎回止める（Phase 3D）
    if (await blockedByBudget(supabase, userId, conversationId, "memory_revise", REVISE.model, sourceMessageId)) {
      return;
    }

    const outcome = await findRevisionTargets(supabase, userId, utterance);

    if (outcome.call) {
      const c = outcome.call;
      await recordUsage(supabase, {
        userId,
        conversationId,
        messageId: sourceMessageId,
        operationType: "memory_revise",
        model: c.ok ? c.model : REVISE.model,
        usage: c.ok ? c.usage : EMPTY_USAGE,
        thinkingTokens: c.ok ? c.thinkingTokens : 0,
        serviceTier: c.ok ? c.serviceTier : null,
        status: c.ok ? "success" : "error",
        errorCode: c.ok ? null : c.errorCode,
        durationMs: c.durationMs,
      });
      if (!c.ok) {
        console.error("[記憶の操作] 対象探しに失敗（会話は成功のまま）:", c.errorCode, c.detail);
        return;
      }
    }

    // 対象が見つからないのは正常。勝手に対象を決めない
    if (outcome.targets.length === 0) return;

    const rows = outcome.targets.map((t, i) => ({
      user_id: userId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      request_index: i + 1,
      intent: t.intent,
      target_memory_id: t.memory.id,
      proposed_text: t.proposedText,
      reason: t.reason,
      status: "pending",
    }));

    const { error } = await supabase.from("memory_revision_requests").insert(rows);
    // 23505 = 同じ発言から既に提案がある（二重実行）。それ以外は記録に残す
    if (error && error.code !== "23505") console.error("[記憶の操作] 提案の保存に失敗:", error);
  } catch (e) {
    console.error("[記憶の操作] 想定外のエラー（会話は成功のまま）:", e);
  }
}

/** 同じ発言から出ていた他の提案（「どちらのことですか」の片方）を閉じる */
async function closeSiblingRequests(
  supabase: SupabaseClient,
  userId: string,
  requestId: string,
  sourceMessageId: string,
) {
  const { error } = await supabase
    .from("memory_revision_requests")
    .update({ status: "dismissed", resolved_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("source_message_id", sourceMessageId)
    .eq("status", "pending")
    .neq("id", requestId);
  if (error) console.error("[記憶の操作] 他の提案を閉じられませんでした:", error);
}

/** 提案を1件読む。自分のもので、まだ判断していないものだけ */
async function loadPendingRequest(supabase: SupabaseClient, userId: string, requestId: string) {
  const { data } = await supabase
    .from("memory_revision_requests")
    .select("id, intent, target_memory_id, proposed_text, conversation_id, source_message_id")
    .eq("id", requestId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .maybeSingle();
  return data;
}

/**
 * ［訂正する］／［考えの変化として残す］。
 *
 * kind は本人が押したボタンで決まる。AIの見立てではない。
 *   correction … 内容が間違っていた。前の内容は無効になる
 *   update     … 考えが変わった。前の考えは「以前の考え」として残る
 *
 * 【同時に走っている処理への備え】
 * 新しい記憶を足すことと、古い記憶を無効にすることは、
 * DB側でひとまとめに行う（revise_memory）。
 * 途中で止まって内容が2つになったり、消えたりすることはない。
 * すでに他の処理が直していたら、何も起きずに「もう直せません」と返る。
 */
export async function applyRevision(input: {
  requestId: string;
  kind: "correction" | "update";
  text: string;
}): Promise<MemoryResult> {
  const { supabase, userId } = await requireUser();

  const text = input.text.trim();
  if (!text) return { ok: false, message: "新しい内容を入力してください。" };
  if (text.length > REVISE.maxTextChars) {
    return { ok: false, message: "長すぎます。500文字までにしてください。" };
  }

  const request = await loadPendingRequest(supabase, userId, input.requestId);
  if (!request) {
    return { ok: false, message: "この内容は、もう処理できません。画面を開き直してみてください。" };
  }

  const { data: newId, error } = await supabase.rpc("revise_memory", {
    target: request.target_memory_id as string,
    kind: input.kind,
    new_text: text,
    in_conversation: request.conversation_id as string,
    in_message: request.source_message_id as string,
    note: input.kind === "correction" ? "本人が訂正" : "本人の考えの変化",
  });

  if (error) {
    console.error("[記憶の操作] 訂正・変化に失敗:", error);
    return { ok: false, message: "うまく処理できませんでした。もう一度お試しください。" };
  }
  if (!newId) {
    // すでに直された・消された・現在有効な内容ではない
    return {
      ok: false,
      message: "この記憶は、すでに直されたか消されています。画面を開き直してみてください。",
    };
  }

  await supabase
    .from("memory_revision_requests")
    .update({ status: "done", resolved_at: new Date().toISOString() })
    .eq("id", request.id as string)
    .eq("user_id", userId);

  await closeSiblingRequests(
    supabase,
    userId,
    request.id as string,
    request.source_message_id as string,
  );

  /* ここで画面を作り直さない。
     作り直すと結果の表示が消え、本人に伝わらないまま終わってしまう。
     （Phase 3A で実際に起きたので、同じ作りにしている） */
  return { ok: true };
}

/** 削除の結果。消した件数も返す（本人に範囲を伝えるため） */
export type DeleteResult = { ok: true; removed: number } | { ok: false; message: string };

/** 記憶だけを消す処理の本体。元の会話・発言はそのまま残る */
async function runDeleteMemory(supabase: SupabaseClient, memoryId: string): Promise<DeleteResult> {
  const { data: removed, error } = await supabase.rpc("delete_memory", { target: memoryId });

  if (error) {
    console.error("[記憶の操作] 削除に失敗:", error);
    return { ok: false, message: "うまく消せませんでした。もう一度お試しください。" };
  }
  if (!removed) {
    return { ok: false, message: "この記憶は、すでに消されています。画面を開き直してみてください。" };
  }
  return { ok: true, removed: removed as number };
}

/**
 * ［削除する］（会話の中の確認から）。
 *
 * つながっている版（訂正前・考えが変わる前）もまとめて消す。
 * 片方だけ残すと、消したはずの内容が「以前の考え」として出てきてしまう。
 */
export async function deleteMemoryByRequest(requestId: string): Promise<DeleteResult> {
  const { supabase, userId } = await requireUser();

  const request = await loadPendingRequest(supabase, userId, requestId);
  if (!request) {
    return { ok: false, message: "この内容は、もう処理できません。画面を開き直してみてください。" };
  }

  const result = await runDeleteMemory(supabase, request.target_memory_id as string);
  if (!result.ok) return result;

  await supabase
    .from("memory_revision_requests")
    .update({ status: "done", resolved_at: new Date().toISOString() })
    .eq("id", request.id as string)
    .eq("user_id", userId);

  await closeSiblingRequests(
    supabase,
    userId,
    request.id as string,
    request.source_message_id as string,
  );

  return result;
}

/**
 * ［削除する］（記憶の一覧から）。
 *
 * ここで画面を作り直さない。
 * 作り直すと「消しました」の表示が一覧の作り直しで消えてしまい、
 * 本人に結果が伝わらないまま終わる（Phase 3A で実際に起きた）。
 * 次に画面を開いたときには、一覧から消えている。
 */
export async function deleteMemory(memoryId: string): Promise<DeleteResult> {
  const { supabase } = await requireUser();
  return runDeleteMemory(supabase, memoryId);
}

/** ［やめる］。記憶は何も変わらない */
export async function dismissRevisionRequest(requestId: string): Promise<MemoryResult> {
  const { supabase, userId } = await requireUser();

  const { data, error } = await supabase
    .from("memory_revision_requests")
    .update({ status: "dismissed", resolved_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("user_id", userId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    console.error("[記憶の操作] 取りやめに失敗:", error);
    return { ok: false, message: "うまく処理できませんでした。もう一度お試しください。" };
  }
  if (!data || data.length === 0) return { ok: false, message: "この内容は、もう処理できません。" };
  return { ok: true };
}

/**
 * 会話ごと消す。
 *
 * 会話・その中の発言・そこから作られた記憶候補と確定記憶・出典が、
 * まとめて消える。原価の記録だけは残る（会話との結び付きが外れるだけ）。
 *
 * 消える前に、削除の記録（本文を持たない）をDB側で残す。
 */
export async function deleteConversation(conversationId: string): Promise<MemoryResult> {
  const { supabase } = await requireUser();

  const { error } = await supabase.rpc("delete_conversation_with_memories", {
    target: conversationId,
  });

  if (error) {
    console.error("[会話の削除] 失敗:", error);
    return { ok: false, message: "うまく消せませんでした。もう一度お試しください。" };
  }

  revalidatePath("/");
  revalidatePath("/memories");
  return { ok: true };
}

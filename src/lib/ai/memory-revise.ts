import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REVISE, SEARCH } from "@/config/ai";
import {
  REVISION_SYSTEM_PROMPT,
  revisionContextBlock,
  type RevisionIntent,
} from "@/config/revision-prompt";
import { EMPTY_USAGE, type UsageCounts } from "./cost";
import type { ChatErrorCode } from "./anthropic";
import { fetchCandidateMemories, lexicalScore, type Memory } from "./memory-search";

/**
 * 記憶の訂正・考えの変化・削除の「対象探し」（Phase 3C）。
 *
 * 【ここでは何も書き換えない】
 * この処理がするのは、
 *   ① 本人の記憶を読み
 *   ② いまの発言がどれを直したい・消したいという話かをAIに考えさせ
 *   ③ 「これのことですか？」という提案を作る
 * だけ。DBの記憶そのものには一切手を触れない。
 *
 * 実際に書き換えるのは、本人が画面のボタンを押したとき（src/app/actions.ts）。
 */

export type RevisionTarget = {
  /** 対象の記憶 */
  memory: Memory;
  /** 本人に見せる操作の種類 */
  intent: RevisionIntent;
  /** 訂正・変化のときの新しい文章の案。削除のときは null */
  proposedText: string | null;
  /** なぜこの記憶が対象だと考えたか（評価用。本人の画面には出さない） */
  reason: string;
};

export type ReviseCall =
  | {
      ok: true;
      model: string;
      usage: UsageCounts;
      thinkingTokens: number;
      serviceTier: string | null;
      durationMs: number;
    }
  | { ok: false; errorCode: ChatErrorCode | "bad_output"; detail: string; durationMs: number };

export type ReviseOutcome = {
  targets: RevisionTarget[];
  /** AIに見せた記憶の件数（0 なら AI を呼んでいない） */
  examined: number;
  call: ReviseCall | null;
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          intent: { type: "string", enum: ["correct", "update", "delete"] },
          new_text: { type: "string" },
          reason: { type: "string" },
        },
        required: ["number", "intent", "new_text", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["targets"],
  additionalProperties: false,
} as const;

type RawTarget = { number: number; intent: RevisionIntent; newText: string; reason: string };

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
}

/** 昔の考えも操作の対象にする（消したい・直したいと言われることがあるため） */
async function fetchPastForRevision(
  supabase: SupabaseClient,
  userId: string,
): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("past_memories")
    .select("id, text, conversation_id, confirmed_at, version")
    .eq("user_id", userId)
    .order("revised_at", { ascending: false })
    .limit(SEARCH.pastFetchLimit);

  if (error) {
    console.error("[記憶の操作] 過去の考えの読み込みに失敗:", error);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    text: r.text as string,
    conversationId: r.conversation_id as string,
    confirmedAt: (r.confirmed_at as string) ?? null,
    isPast: true,
    version: (r.version as number) ?? 1,
  }));
}

/**
 * 本人の記憶（現在の内容と過去の考え）を取り出し、AIに見せる分だけに絞る。
 *
 * 削除・訂正の対象は「昔の言い方」で指されることも多いので、
 * 過去の考えも対象に含める。ただし訂正された旧版（superseded）と
 * 削除済みは view に入っていないので、最初から出てこない。
 */
async function fetchRevisionCandidates(
  supabase: SupabaseClient,
  userId: string,
  utterance: string,
): Promise<Memory[]> {
  /* 検索と同じ取り出し方（Phase 3D で件数の打ち切りをやめた）。
     消したい記憶が古くて見つからない、ということが起きないようにする。 */
  const [current, past] = await Promise.all([
    fetchCandidateMemories(supabase, userId, utterance, false),
    fetchPastForRevision(supabase, userId),
  ]);

  const all: Memory[] = [...current, ...past];

  // 文字の重なりが強い順 → 元の並び順
  const scored = all
    .map((m, i) => ({ m, score: lexicalScore(utterance, m.text), order: i }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const picked: Memory[] = [];
  let chars = 0;
  for (const { m } of scored) {
    if (picked.length >= REVISE.candidateLimit) break;
    if (chars + m.text.length > REVISE.candidateChars) continue;
    picked.push(m);
    chars += m.text.length;
  }
  return picked;
}

/**
 * 「それ違うよ」「○○の記憶を消して」等の発言から、対象の記憶を探す。
 *
 * 見つからなければ 0件。**0件は正しい答え**（勝手に対象を決めない）。
 * 失敗しても会話は続ける。
 */
export async function findRevisionTargets(
  supabase: SupabaseClient,
  userId: string,
  utterance: string,
): Promise<ReviseOutcome> {
  const candidates = await fetchRevisionCandidates(supabase, userId, utterance);
  if (candidates.length === 0) return { targets: [], examined: 0, call: null };

  const client = getClient();
  if (!client) {
    return {
      targets: [],
      examined: candidates.length,
      call: { ok: false, errorCode: "no_api_key", detail: "ANTHROPIC_API_KEY が未設定", durationMs: 0 },
    };
  }

  const startedAt = Date.now();
  try {
    const response = await client.messages.create({
      model: REVISE.model,
      max_tokens: REVISE.maxTokens,
      // 毎回同じ文なので使い回しの印を付ける（入力ぶんの費用を下げる）
      system: [{ type: "text", text: REVISION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: revisionContextBlock(candidates, utterance) }],
      output_config: {
        effort: REVISE.effort,
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
    });

    const durationMs = Date.now() - startedAt;
    const usage: UsageCounts = {
      ...EMPTY_USAGE,
      input_tokens: response.usage.input_tokens ?? 0,
      output_tokens: response.usage.output_tokens ?? 0,
      cache_creation_5m_tokens: response.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cache_creation_1h_tokens: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const call: ReviseCall = {
      ok: true,
      model: response.model,
      usage,
      thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
      serviceTier: response.usage.service_tier ?? null,
      durationMs,
    };

    if (response.stop_reason === "refusal") {
      return {
        targets: [],
        examined: candidates.length,
        call: { ok: false, errorCode: "refusal", detail: "モデルが応答を控えました", durationMs },
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const raw = parseTargets(text);
    if (raw === null) {
      return {
        targets: [],
        examined: candidates.length,
        call: { ok: false, errorCode: "bad_output", detail: "返ってきた形が読めませんでした", durationMs },
      };
    }

    return { targets: toTargets(raw, candidates), examined: candidates.length, call };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const code: ChatErrorCode =
      error instanceof Anthropic.AuthenticationError
        ? "auth"
        : error instanceof Anthropic.RateLimitError
          ? "rate_limit"
          : error instanceof Anthropic.APIConnectionTimeoutError
            ? "timeout"
            : error instanceof Anthropic.APIConnectionError
              ? "network"
              : "api_error";
    return {
      targets: [],
      examined: candidates.length,
      call: { ok: false, errorCode: code, detail: String(error), durationMs },
    };
  }
}

/** 番号を記憶に戻し、件数と文字数の上限をここで必ず守る */
export function toTargets(raw: RawTarget[], candidates: Memory[]): RevisionTarget[] {
  const out: RevisionTarget[] = [];
  for (const t of raw) {
    const memory = candidates[t.number - 1];
    if (!memory) continue;
    if (out.some((x) => x.memory.id === memory.id)) continue;
    if (out.length >= REVISE.maxTargets) break;

    const proposed = t.newText.trim().slice(0, REVISE.maxTextChars);
    /* 訂正・変化なのに新しい文章がない提案は捨てる。
       中身のない訂正を本人に見せても決めようがない。 */
    if (t.intent !== "delete" && !proposed) continue;

    out.push({
      memory,
      intent: t.intent,
      proposedText: t.intent === "delete" ? null : proposed,
      reason: t.reason.trim().slice(0, 300),
    });
  }
  return out;
}

/** 返ってきた提案を読み取る。形が違えば null（＝何も提案しない） */
export function parseTargets(text: string): RawTarget[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const list = (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(list)) return null;

  const out: RawTarget[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (!Number.isInteger(o.number) || (o.number as number) < 1) continue;
    if (o.intent !== "correct" && o.intent !== "update" && o.intent !== "delete") continue;
    out.push({
      number: o.number as number,
      intent: o.intent,
      newText: typeof o.new_text === "string" ? o.new_text : "",
      reason: typeof o.reason === "string" ? o.reason : "",
    });
  }
  return out;
}

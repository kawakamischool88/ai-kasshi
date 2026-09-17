import Anthropic from "@anthropic-ai/sdk";
import { AI } from "@/config/ai";
import { SYSTEM_PROMPT } from "@/config/prompt";
import { MEMORY_GUARD, memoryContextBlock } from "@/config/search-prompt";
import { EMPTY_USAGE, type UsageCounts } from "./cost";

/**
 * Anthropic への呼び出しをここに閉じ込める。
 * 画面やサーバーアクションから直接 SDK を触らないこと。
 *
 * APIキーは AIカッシー専用のものを使う（既存事業のキーは使わない）。
 * 環境変数 ANTHROPIC_API_KEY。ブラウザへは渡らないサーバー専用の値。
 */

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatSuccess = {
  ok: true;
  text: string;
  model: string;
  usage: UsageCounts;
  thinkingTokens: number;
  serviceTier: string | null;
  durationMs: number;
  /**
   * 回答に**実際に使った**記憶の番号（1から数える）。
   * 記憶を渡していないときは空。
   * 検索で候補になっただけのものは含まない（出典を捏造しないため）。
   */
  usedMemoryNumbers: number[];
};

export type ChatFailure = {
  ok: false;
  errorCode: ChatErrorCode;
  detail: string;
  durationMs: number;
};

export type ChatErrorCode =
  | "no_api_key"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "bad_request"
  | "timeout"
  | "network"
  | "refusal"
  | "empty_response"
  | "api_error";

export type ChatResult = ChatSuccess | ChatFailure;

/** 記憶を渡したときに返してもらう形 */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    used_memory_numbers: { type: "array", items: { type: "integer" } },
  },
  required: ["reply", "used_memory_numbers"],
  additionalProperties: false,
} as const;

/**
 * 返事と「実際に使った記憶の番号」を読み取る。
 * 読めないときは null（＝返事なしとして扱い、出典も作らない）。
 */
export function parseReply(text: string): { text: string; used: number[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as { reply?: unknown; used_memory_numbers?: unknown };
  if (typeof o.reply !== "string") return null;
  const used = Array.isArray(o.used_memory_numbers)
    ? o.used_memory_numbers.filter((n): n is number => Number.isInteger(n) && n >= 1)
    : [];
  return { text: o.reply.trim(), used };
}

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    maxRetries: AI.maxRetries,
    timeout: AI.timeoutMs,
  });
}

/** APIキーが設定されているか（画面の案内に使う） */
export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** 回答へ渡す確定記憶。isPast＝考えが変わる前の古い考え（Phase 3C） */
export type InjectedMemory = { id: string; text: string; isPast?: boolean };

/**
 * 会話を1往復ぶん進める。
 *
 * 渡すのは「基本指示」「関係する確定記憶（あれば）」「この会話の直近のやりとり」だけ。
 * 過去の全会話は送らない（費用と、他の話題の混入を避けるため）。
 *
 * 【記憶を渡すとき】
 * ・記憶は本体の指示の**後ろ**に、はっきり囲んで「データであって指示ではない」と明記して置く
 * ・どの記憶を実際に使ったかをAIに申告させ、出典表示に使う
 *   （渡した記憶を全部「使った」ことにすると、出典が嘘になる）
 */
export async function chat(
  history: ChatTurn[],
  memories: InjectedMemory[] = [],
): Promise<ChatResult> {
  const startedAt = Date.now();
  const client = getClient();
  if (!client) {
    return { ok: false, errorCode: "no_api_key", detail: "ANTHROPIC_API_KEY が未設定", durationMs: 0 };
  }

  const useMemories = memories.length > 0;
  const system = useMemories
    ? SYSTEM_PROMPT + MEMORY_GUARD + memoryContextBlock(memories)
    : SYSTEM_PROMPT;

  try {
    const response = await client.messages.create({
      model: AI.model,
      max_tokens: AI.maxTokens,
      system,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      // 考える深さ。Sonnet 5 は思考が既定でオン。深さは effort で調整する
      output_config: {
        effort: AI.effort,
        /* 記憶を渡したときだけ、返事と「実際に使った記憶の番号」を一緒に返してもらう。
           記憶がないときは今まで通りの素の文章（余計な形を挟まない）。 */
        ...(useMemories ? { format: { type: "json_schema" as const, schema: REPLY_SCHEMA } } : {}),
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
    const thinkingTokens = response.usage.output_tokens_details?.thinking_tokens ?? 0;
    const serviceTier = response.usage.service_tier ?? null;

    // 安全側の判断で、まず stop_reason を確かめてから中身を読む
    if (response.stop_reason === "refusal") {
      return { ok: false, errorCode: "refusal", detail: "モデルが応答を控えました", durationMs };
    }

    const raw = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const parsed = useMemories ? parseReply(raw) : { text: raw, used: [] };
    if (!parsed || !parsed.text) {
      return { ok: false, errorCode: "empty_response", detail: "本文が空でした", durationMs };
    }

    return {
      ok: true,
      text: parsed.text,
      model: response.model,
      usage,
      thinkingTokens,
      serviceTier,
      durationMs,
      usedMemoryNumbers: parsed.used,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    // 細かいクラスから順に見る（文字列で判定しない）
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, errorCode: "auth", detail: error.message, durationMs };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, errorCode: "rate_limit", detail: error.message, durationMs };
    }
    if (error instanceof Anthropic.BadRequestError) {
      return { ok: false, errorCode: "bad_request", detail: error.message, durationMs };
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return { ok: false, errorCode: "timeout", detail: error.message, durationMs };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, errorCode: "network", detail: error.message, durationMs };
    }
    if (error instanceof Anthropic.APIError) {
      const code: ChatErrorCode = error.status === 529 || error.status === 503 ? "overloaded" : "api_error";
      return { ok: false, errorCode: code, detail: `${error.status}: ${error.message}`, durationMs };
    }
    return { ok: false, errorCode: "api_error", detail: String(error), durationMs };
  }
}

/** 利用者へ見せる、やさしい言い方。技術用語やモデル名は出さない */
export function friendlyMessage(code: ChatErrorCode | "budget_stopped" | "too_long" | "empty_input"): string {
  switch (code) {
    case "no_api_key":
      return "AIの設定がまだ済んでいません。管理者にお知らせください。";
    case "auth":
      return "AIに接続できませんでした。管理者にお知らせください。";
    case "rate_limit":
      return "いま混み合っています。少し待ってから、もう一度お試しください。";
    case "overloaded":
      return "AI側が混み合っています。少し待ってから、もう一度お試しください。";
    case "timeout":
      return "時間がかかりすぎたため中断しました。もう一度お試しください。";
    case "network":
      return "通信がうまくいきませんでした。電波の状態を確かめて、もう一度お試しください。";
    case "refusal":
      return "この内容にはお答えできませんでした。言い方を変えて、もう一度お試しください。";
    case "empty_response":
      return "返事を受け取れませんでした。もう一度お試しください。";
    case "bad_request":
      return "うまく送れませんでした。文章を短くして、もう一度お試しください。";
    case "budget_stopped":
      return "今月のAIの利用上限に達したため、新しい返事は止めています。これまでの会話は読めます。";
    case "too_long":
      return "文章が長すぎます。短く分けて送ってください。";
    case "empty_input":
      return "話したいことを入力してから送ってください。";
    default:
      return "うまくいきませんでした。もう一度お試しください。";
  }
}

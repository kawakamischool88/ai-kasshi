import Anthropic from "@anthropic-ai/sdk";
import { MEMORY } from "@/config/ai";
import {
  MEMORY_SYSTEM_PROMPT,
  REQUESTED_INSTRUCTION,
  alreadySuggestedInstruction,
  ORIGINS,
  type Origin,
} from "@/config/memory-prompt";
import { EMPTY_USAGE, type UsageCounts } from "./cost";
import type { ChatTurn, ChatErrorCode } from "./anthropic";

/**
 * 記憶候補の抽出（Phase 3A）。
 *
 * 会話の返事とは**別の呼び出し**にしてある。
 * ・利用量は operation_type = "memory_extract" として別に記録する
 * ・ここが失敗しても、会話そのものは成功扱いにする（呼び出し側で扱う）
 * ・将来、抽出だけ安いモデルに変えるときは src/config/ai.ts の MEMORY.model を変えるだけ
 */

export type Candidate = {
  text: string;
  origin: Origin;
  reason: string;
};

export type ExtractSuccess = {
  ok: true;
  candidates: Candidate[];
  model: string;
  usage: UsageCounts;
  thinkingTokens: number;
  serviceTier: string | null;
  durationMs: number;
};

export type ExtractFailure = {
  ok: false;
  errorCode: ChatErrorCode | "bad_output";
  detail: string;
  durationMs: number;
};

export type ExtractResult = ExtractSuccess | ExtractFailure;

/** AIに返してもらう形。構造化出力で形を保証する */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          origin: { type: "string", enum: [...ORIGINS] },
          reason: { type: "string" },
        },
        required: ["text", "origin", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
}

/**
 * 直近のやりとりから記憶候補を取り出す。
 *
 * @param history AIへ見せる直近のやりとり（最後は本人の発言＋AIの返事）
 * @param requestedByUser 本人がはっきり保存を希望したか
 * @param alreadySuggested この会話ですでに提案済みの候補文。同じ内容を繰り返さないために渡す
 */
export async function extractCandidates(
  history: ChatTurn[],
  requestedByUser: boolean,
  alreadySuggested: string[] = [],
): Promise<ExtractResult> {
  const startedAt = Date.now();
  const client = getClient();
  if (!client) {
    return { ok: false, errorCode: "no_api_key", detail: "ANTHROPIC_API_KEY が未設定", durationMs: 0 };
  }

  // 会話そのものではなく「この記録から取り出す」という作業として渡す
  const transcript = history
    .map((m) => `${m.role === "user" ? "本人" : "AIカッシー"}：${m.content}`)
    .join("\n\n");

  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";

  /* 毎回変わる指示は本文側に入れる。
     システム側の指示は常に同じ文にしておき、使い回し（キャッシュ）を効かせて
     入力ぶんの費用を抑える。 */
  const userContent = [
    `次は、本人とAIカッシーのやりとりの記録です。`,
    `\n---\n${transcript}\n---`,
    `\n【今回の対象】いちばん最後の本人の発言は次のものです。この発言から取り出してください。`,
    `「${lastUser}」`,
    alreadySuggestedInstruction(alreadySuggested),
    requestedByUser ? REQUESTED_INSTRUCTION : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await client.messages.create({
      model: MEMORY.model,
      max_tokens: MEMORY.maxTokens,
      // 毎回同じ文なので、使い回しの印を付けて入力ぶんの費用を下げる
      system: [
        {
          type: "text",
          text: MEMORY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: {
        effort: MEMORY.effort,
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
    const base = {
      model: response.model,
      usage,
      thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
      serviceTier: response.usage.service_tier ?? null,
      durationMs,
    };

    if (response.stop_reason === "refusal") {
      return { ok: false, errorCode: "refusal", detail: "モデルが応答を控えました", durationMs };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const candidates = parseCandidates(text);
    if (candidates === null) {
      return { ok: false, errorCode: "bad_output", detail: "返ってきた形が読めませんでした", durationMs };
    }

    return { ok: true, candidates: candidates.slice(0, MEMORY.maxCandidates), ...base };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof Anthropic.AuthenticationError)
      return { ok: false, errorCode: "auth", detail: error.message, durationMs };
    if (error instanceof Anthropic.RateLimitError)
      return { ok: false, errorCode: "rate_limit", detail: error.message, durationMs };
    if (error instanceof Anthropic.APIConnectionTimeoutError)
      return { ok: false, errorCode: "timeout", detail: error.message, durationMs };
    if (error instanceof Anthropic.APIConnectionError)
      return { ok: false, errorCode: "network", detail: error.message, durationMs };
    if (error instanceof Anthropic.APIError)
      return { ok: false, errorCode: "api_error", detail: `${error.status}: ${error.message}`, durationMs };
    return { ok: false, errorCode: "api_error", detail: String(error), durationMs };
  }
}

/**
 * 返ってきた文字列を候補の一覧にする。
 * 形が違えば null を返し、呼び出し側は「抽出できなかった」として扱う。
 * （おかしな候補を本人へ見せるより、出さない方がよい）
 */
export function parseCandidates(text: string): Candidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const list = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) return null;

  const out: Candidate[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const candidateText = typeof c.text === "string" ? c.text.trim() : "";
    const origin = typeof c.origin === "string" ? c.origin : "";
    const reason = typeof c.reason === "string" ? c.reason.trim() : "";

    if (!candidateText) continue;
    if (!(ORIGINS as readonly string[]).includes(origin)) continue;
    // 本人が採用していないAIの提案は、本人の記憶にしない
    if (origin === "ai_suggestion") continue;

    out.push({ text: candidateText, origin: origin as Origin, reason });
  }
  return out;
}

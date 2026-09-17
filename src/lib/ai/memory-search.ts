import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SEARCH } from "@/config/ai";
import { SEARCH_SYSTEM_PROMPT } from "@/config/search-prompt";
import { EMPTY_USAGE, type UsageCounts } from "./cost";
import type { ChatErrorCode } from "./anthropic";

/**
 * 確定記憶の検索（Phase 3B）。
 *
 * 【検索できる範囲】
 * `confirmed_memories`（確定済みだけを見せる view）だけを見る。
 * memory_candidates を直接見てはいけない（未確定・却下・期限切れが混ざるため）。
 *
 * 【他人の記憶を見ないための作り】
 * 全員のぶんを取ってから絞るのではなく、**最初から本人のぶんだけ**を取る。
 * RLS に加えて、問い合わせにも user_id の条件を書いてある（二重の守り）。
 */

export type Memory = {
  id: string;
  text: string;
  conversationId: string;
  confirmedAt: string | null;
  /**
   * 「考えが変わる前の考え」か（Phase 3C）。
   * ふだんの検索では出てこない。昔を聞かれたときだけ混ざる。
   */
  isPast: boolean;
};

export type SearchOutcome = {
  /** 回答へ渡す記憶（最大 SEARCH.maxInject 件）。関係がなければ空 */
  selected: Memory[];
  /** AIに見せて選ばせた件数（0 なら AI を呼んでいない） */
  examined: number;
  /** AIの呼び出し結果。呼んでいなければ null */
  call: SelectCall | null;
};

export type SelectCall =
  | {
      ok: true;
      model: string;
      usage: UsageCounts;
      thinkingTokens: number;
      serviceTier: string | null;
      durationMs: number;
    }
  | { ok: false; errorCode: ChatErrorCode | "bad_output"; detail: string; durationMs: number };

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    selected: { type: "array", items: { type: "integer" } },
  },
  required: ["selected"],
  additionalProperties: false,
} as const;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
}

/**
 * 日本語は語の間に空白がないため、2文字ずつの並びで重なりを数える。
 * 人名・商品名・案件名などの文字一致を拾う補助。
 */
export function lexicalScore(question: string, memory: string): number {
  const norm = (s: string) => s.replace(/[\s　、。,.「」『』（）()]/g, "");
  const q = norm(question);
  const m = norm(memory);
  if (q.length < 2 || m.length < 2) return 0;

  const grams = new Set<string>();
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2));

  let hit = 0;
  for (const g of grams) if (m.includes(g)) hit++;
  return hit / grams.size;
}

/**
 * 本人の確定記憶を取り出し、AIに見せる分だけに絞る。
 *
 * 件数が上限を超えるときは、
 *   ① 質問と文字が重なるもの（固有名詞など）を優先
 *   ② 残りは新しい順
 * で選ぶ。
 */
export async function fetchCandidateMemories(
  supabase: SupabaseClient,
  userId: string,
  question: string,
  /**
   * 「昔はどう考えていた？」と聞かれたときだけ true。
   * ふだんは false ＝ 現在有効な内容だけを見る（昔と今を混ぜないため）。
   */
  includePast = false,
): Promise<Memory[]> {
  const { data, error } = await supabase
    .from("confirmed_memories")
    .select("id, text, conversation_id, confirmed_at")
    .eq("user_id", userId) // RLS に加えて明示（他人のぶんは最初から対象にしない）
    .order("confirmed_at", { ascending: false })
    .limit(SEARCH.fetchLimit);

  if (error) {
    console.error("[記憶検索] 確定記憶の読み込みに失敗:", error);
    return [];
  }

  const all: Memory[] = (data ?? []).map((r) => ({
    id: r.id as string,
    text: r.text as string,
    conversationId: r.conversation_id as string,
    confirmedAt: (r.confirmed_at as string) ?? null,
    isPast: false,
  }));

  /* 昔を聞かれたときだけ、過去の考えも足す（Phase 3C）。
     訂正された旧版（superseded）は past_memories に入っていないので、
     「間違いだった内容」が昔の考えとして持ち出されることはない。 */
  if (includePast) {
    const { data: past, error: pastError } = await supabase
      .from("past_memories")
      .select("id, text, conversation_id, confirmed_at")
      .eq("user_id", userId)
      .order("revised_at", { ascending: false })
      .limit(SEARCH.pastFetchLimit);

    if (pastError) console.error("[記憶検索] 過去の考えの読み込みに失敗:", pastError);
    for (const r of past ?? []) {
      all.push({
        id: r.id as string,
        text: r.text as string,
        conversationId: r.conversation_id as string,
        confirmedAt: (r.confirmed_at as string) ?? null,
        isPast: true,
      });
    }
  }

  // 文字の重なりが強い順 → 新しい順（安定した並びにする）
  const scored = all
    .map((m, i) => ({ m, score: lexicalScore(question, m.text), order: i }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const picked: Memory[] = [];
  let chars = 0;
  for (const { m } of scored) {
    if (picked.length >= SEARCH.candidateLimit) break;
    if (chars + m.text.length > SEARCH.candidateChars) continue;
    picked.push(m);
    chars += m.text.length;
  }
  return picked;
}

/**
 * この会話の中で、すでにAIが使った確定記憶を取り出す。
 *
 * 【なぜ必要か】
 * 記憶は「関係があるターン」にだけ渡している。
 * するとAIは、次のターンで自分の発言（「以前こうおっしゃっていましたね」）を見たときに、
 * 手元に記録がないため「作り話をしてしまった」と誤解し、
 * **正しかった内容を訂正して謝ってしまう**（実際に起きた）。
 *
 * 一度使った記憶は、その会話の間は渡し続けることで、この食い違いをなくす。
 */
export async function fetchUsedMemoriesInConversation(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<Memory[]> {
  const { data: msgs } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant");

  const ids = (msgs ?? []).map((m) => m.id as string);
  if (ids.length === 0) return [];

  const { data: refs } = await supabase
    .from("memory_references")
    .select("memory_id")
    .in("message_id", ids);

  const memoryIds = [...new Set((refs ?? []).map((r) => r.memory_id as string))];
  if (memoryIds.length === 0) return [];

  // 確定済みだけを見せる view から引く（あとで確定でなくなったものは出てこない）
  const { data } = await supabase
    .from("confirmed_memories")
    .select("id, text, conversation_id, confirmed_at")
    .eq("user_id", userId)
    .in("id", memoryIds);

  return (data ?? []).map((r) => ({
    id: r.id as string,
    text: r.text as string,
    conversationId: r.conversation_id as string,
    confirmedAt: (r.confirmed_at as string) ?? null,
    isPast: false,
  }));
}

/**
 * 回答へ渡す直前に、その記憶がいまも使える状態かを確かめ直す（Phase 3C）。
 *
 * 【なぜ必要か】
 * 検索してから回答を作るまでの間に、別の画面で削除・訂正が行われることがある。
 * 古い検索結果をそのまま渡すと、**消したはずの内容がAIの回答に出てしまう**。
 * 呼び出しの直前に引き直し、いま使える記憶だけに絞る。
 *
 * 過去の考え（isPast）は confirmed には入っていないので、別に確かめる。
 */
export async function keepStillUsable(
  supabase: SupabaseClient,
  userId: string,
  memories: Memory[],
): Promise<Memory[]> {
  if (memories.length === 0) return [];

  const currentIds = memories.filter((m) => !m.isPast).map((m) => m.id);
  const pastIds = memories.filter((m) => m.isPast).map((m) => m.id);
  const alive = new Set<string>();

  if (currentIds.length > 0) {
    const { data, error } = await supabase
      .from("confirmed_memories")
      .select("id")
      .eq("user_id", userId)
      .in("id", currentIds);
    // 確かめられなかったときは安全側に倒し、記憶を渡さない
    if (error) {
      console.error("[記憶検索] 渡す直前の確認に失敗（記憶なしで続行）:", error);
      return [];
    }
    for (const r of data ?? []) alive.add(r.id as string);
  }

  if (pastIds.length > 0) {
    const { data, error } = await supabase
      .from("past_memories")
      .select("id")
      .eq("user_id", userId)
      .in("id", pastIds);
    if (error) {
      console.error("[記憶検索] 渡す直前の確認に失敗（記憶なしで続行）:", error);
      return [];
    }
    for (const r of data ?? []) alive.add(r.id as string);
  }

  return memories.filter((m) => alive.has(m.id));
}

/**
 * いまの相談に関係する確定記憶だけを選ぶ。
 *
 * 記憶が1件もなければ AI を呼ばない（呼び出し費用をかけない）。
 * 失敗したときは「関係する記憶なし」として扱い、会話はそのまま続ける。
 */
export async function searchMemories(
  supabase: SupabaseClient,
  userId: string,
  question: string,
  /** 「昔はどう考えていた？」と聞かれたときだけ true（Phase 3C） */
  includePast = false,
): Promise<SearchOutcome> {
  const candidates = await fetchCandidateMemories(supabase, userId, question, includePast);
  if (candidates.length === 0) return { selected: [], examined: 0, call: null };

  const client = getClient();
  if (!client) {
    return {
      selected: [],
      examined: candidates.length,
      call: { ok: false, errorCode: "no_api_key", detail: "ANTHROPIC_API_KEY が未設定", durationMs: 0 },
    };
  }

  const startedAt = Date.now();
  // 過去の考えには印を付ける。昔を聞かれたときだけ選んでもらうため（Phase 3C）
  const list = candidates
    .map((m, i) => `${i + 1}. ${m.text}${m.isPast ? "（これは、考えが変わる前の古い考えです）" : ""}`)
    .join("\n");

  try {
    const response = await client.messages.create({
      model: SEARCH.model,
      max_tokens: SEARCH.maxTokens,
      // 毎回同じ文なので使い回しの印を付ける（入力ぶんの費用を下げる）
      system: [{ type: "text", text: SEARCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `【いまの本人の発言】\n「${question}」\n\n【本人が過去に残した記録】\n${list}\n\nこの発言に本当に役立つ記録だけを選んでください。役立つものがなければ空で返してください。`,
        },
      ],
      output_config: {
        effort: SEARCH.effort,
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
    const call: SelectCall = {
      ok: true,
      model: response.model,
      usage,
      thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? 0,
      serviceTier: response.usage.service_tier ?? null,
      durationMs,
    };

    if (response.stop_reason === "refusal") {
      return {
        selected: [],
        examined: candidates.length,
        call: { ok: false, errorCode: "refusal", detail: "モデルが応答を控えました", durationMs },
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const numbers = parseSelected(text);
    if (numbers === null) {
      return {
        selected: [],
        examined: candidates.length,
        call: { ok: false, errorCode: "bad_output", detail: "返ってきた形が読めませんでした", durationMs },
      };
    }

    // 番号を記憶に戻す。件数と文字数の上限をここで必ず守る
    const selected: Memory[] = [];
    let chars = 0;
    for (const n of numbers) {
      const m = candidates[n - 1];
      if (!m) continue;
      if (selected.some((s) => s.id === m.id)) continue;
      if (selected.length >= SEARCH.maxInject) break;
      if (chars + m.text.length > SEARCH.injectChars) continue;
      selected.push(m);
      chars += m.text.length;
    }

    return { selected, examined: candidates.length, call };
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
      selected: [],
      examined: candidates.length,
      call: { ok: false, errorCode: code, detail: String(error), durationMs },
    };
  }
}

/** 選ばれた番号を読み取る。形が違えば null（＝記憶を使わない） */
export function parseSelected(text: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const list = (parsed as { selected?: unknown }).selected;
  if (!Array.isArray(list)) return null;
  return list.filter((n): n is number => Number.isInteger(n) && n >= 1);
}

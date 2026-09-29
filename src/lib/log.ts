/**
 * サーバーのログ（Vercel の Runtime Logs）へ出すための、ただ1つの出入り口。
 *
 * 【なぜ要るか】
 * 以前は DB やAIのエラーを、そのままログへ出していた。
 * DB は書き込みが決まりに引っかかると「失敗した行の値すべて」を
 * エラーの詳細（details）に入れて返す。つまり、本人の発言・AIの返事・
 * 記憶の本文が、そのままログに残るおそれがあった。
 *
 * 【ここで守ること】
 * ・ログに出せるのは、下に並べた「決まった名前」と「形を確かめた番号」と「数値」だけ
 * ・自由な文章、DB の message / details / hint、例外そのもの、AIのエラー文は
 *   **型のうえで渡せない**（番号は dbCode / errName / aiCode を通したものしか受け取らない）
 * ・ユーザーID・会話ID・発言ID などの番号も出さない
 *   （誰の・どの処理かは、ai_usage の記録と時刻で突き合わせられる）
 * ・ログを出すこと自体が失敗しても、処理は止めない
 */

// =============================================================
// 決まった名前
// =============================================================

/** どの処理か */
const OPS = [
  "conversation.create",
  "conversation.delete",
  "usage.record",
  "send.save_user_message",
  "turn.load_history",
  "turn.chat",
  "turn.save_reply",
  "turn.memory_changed",
  "reference.record",
  "memory.search",
  "memory.search_load",
  "memory.search_check",
  "memory.extract",
  "candidate.save",
  "candidate.skip_deleted_source",
  "candidate.fallback_to_utterance",
  "candidate.expire",
  "candidate.confirm",
  "candidate.reject",
  "revision.find",
  "revision.load_past",
  "revision.save_request",
  "revision.close_siblings",
  "revision.apply",
  "revision.dismiss",
  "memory.delete",
  "budget.sum",
  "admin.check",
  "export.build",
  "pdf.build",
] as const;
export type Op = (typeof OPS)[number];

/** 処理のどの段階か */
const STAGES = ["select", "insert", "update", "rpc", "ai", "build", "check"] as const;
export type Stage = (typeof STAGES)[number];

/** 失敗の大まかな種類 */
const KINDS = ["db", "ai", "exception", "check"] as const;
export type Kind = (typeof KINDS)[number];

/** 失敗ではない出来事（成功・注意） */
const EVENTS = [
  "done",
  "done_this_month",
  "done_last_month",
  "discarded",
  "skipped",
  "fallback",
  "truncated",
  "forbidden_word",
  "deleted_text_found",
  "unknown_id_found",
] as const;
export type LogEvent = (typeof EVENTS)[number];

/** 出してよい数値の名前 */
const NUM_KEYS = ["count", "bytes", "ms", "kept", "changed", "corrected", "index"] as const;
export type NumKey = (typeof NUM_KEYS)[number];
export type Nums = Partial<Record<NumKey, number>>;

/** アプリで決めたAIの失敗の種類（src/lib/ai の各所と同じ） */
const AI_CODES = [
  "no_api_key",
  "auth",
  "rate_limit",
  "overloaded",
  "bad_request",
  "timeout",
  "network",
  "refusal",
  "empty_response",
  "api_error",
  "bad_output",
] as const;
export type AiCode = (typeof AI_CODES)[number];

// =============================================================
// 形を確かめた番号
//
// SafeCode は、下の3つの関数からしか作れない（ほかの文字列は型が合わない）。
// =============================================================

declare const safeCodeBrand: unique symbol;
export type SafeCode = string & { readonly [safeCodeBrand]: true };

/**
 * DB（Supabase）の番号として受け付ける形。
 *   ・Postgres の番号（英数字5文字。例 23514・42501・P0001）
 *   ・PostgREST の番号（例 PGRST116）
 *   ・通信の失敗の番号（例 ECONNRESET・UND_ERR_CONNECT_TIMEOUT）
 * これ以外は「番号なし」として扱う。
 */
const DB_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3}|E[A-Z]{2,20}|UND_ERR_[A-Z_]{1,30})$/;

/**
 * DB のエラーから、番号だけを取り出す。
 * message・details・hint は**読まない**（行の値・入力値・接続先が入り得るため）。
 */
export function dbCode(error: unknown): SafeCode | undefined {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" && DB_CODE.test(code) ? (code as SafeCode) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 例外の種類として出してよい名前。
 * 名前は作る側が自由に付けられるので、ここにあるものだけを出す（ほかは OtherError）。
 */
const ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
  "PostgrestError",
  "AuthApiError",
  "AuthRetryableFetchError",
  "APIError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "NonError",
  "OtherError",
] as const;

/**
 * 例外から、種類の名前だけを取り出す（TypeError など）。
 * 例外の文（message）と呼び出しの経路（stack）は**読まない**。
 */
export function errName(error: unknown): SafeCode {
  try {
    if (!(error instanceof Error)) return "NonError" as SafeCode;
    const name = error.name;
    return ((ERROR_NAMES as readonly string[]).includes(name) ? name : "OtherError") as SafeCode;
  } catch {
    return "OtherError" as SafeCode;
  }
}

/** アプリで決めたAIの失敗の種類を、そのまま番号として使う（知らない値は出さない） */
export function aiCode(code: AiCode): SafeCode {
  return ((AI_CODES as readonly string[]).includes(code) ? code : "unknown") as SafeCode;
}

// =============================================================
// ログを出す
// =============================================================

function pick<T extends string>(list: readonly T[], value: T): string {
  return (list as readonly string[]).includes(value) ? value : "unknown";
}

function numPart(nums: Nums | undefined): string {
  if (!nums) return "";
  let out = "";
  for (const key of NUM_KEYS) {
    const v = nums[key];
    if (typeof v === "number" && Number.isFinite(v)) out += ` ${key}=${Math.round(v)}`;
  }
  return out;
}

function codePart(code: SafeCode | undefined): string {
  /* 型で守っているが、型を無理に外して渡されたときのために、
     出す直前にも「3つの関数が作る形」のどれかに当たるかを確かめる */
  if (typeof code !== "string") return "";
  const ok =
    DB_CODE.test(code) ||
    (AI_CODES as readonly string[]).includes(code) ||
    (ERROR_NAMES as readonly string[]).includes(code);
  return ok ? ` code=${code}` : " code=invalid";
}

/**
 * 失敗を1行で出す。
 *
 * 例）[ai-kasshi] fail op=send.save_user_message stage=insert kind=db code=23514
 */
export function logFailure(
  op: Op,
  info: { stage: Stage; kind: Kind; code?: SafeCode; status?: number; ms?: number },
): void {
  try {
    const status =
      typeof info.status === "number" && Number.isInteger(info.status) ? ` status=${info.status}` : "";
    console.error(
      `[ai-kasshi] fail op=${pick(OPS, op)} stage=${pick(STAGES, info.stage)} kind=${pick(KINDS, info.kind)}` +
        codePart(info.code) +
        status +
        numPart({ ms: info.ms }),
    );
  } catch {
    // ログのせいで処理を止めない
  }
}

/**
 * 失敗ではない出来事（成功・注意）を1行で出す。数値だけ添えられる。
 *
 * 例）[ai-kasshi] info op=export.build event=done bytes=12345 ms=210
 */
export function logEvent(op: Op, event: LogEvent, nums?: Nums): void {
  try {
    console.log(`[ai-kasshi] info op=${pick(OPS, op)} event=${pick(EVENTS, event)}` + numPart(nums));
  } catch {
    // ログのせいで処理を止めない
  }
}

/** 注意（記憶が途中で変わった・上限に達した等）。形は logEvent と同じで、警告として出す */
export function logWarn(op: Op, event: LogEvent, nums?: Nums): void {
  try {
    console.warn(`[ai-kasshi] warn op=${pick(OPS, op)} event=${pick(EVENTS, event)}` + numPart(nums));
  } catch {
    // ログのせいで処理を止めない
  }
}

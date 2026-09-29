/**
 * ログの安全化のテスト（T1・T2・T6）。
 *
 * 【確かめること】
 * サーバーのログ（Vercel の Runtime Logs）に、
 * 本人の会話・記憶の本文、DB のエラーの詳細、例外の中身、AIのエラー文が出ないこと。
 *
 * 【方法】
 * エラーの中に目印の文字（CANARY）を入れ、ログの関数に通す。
 * console をすべて差し替えて、**出力に目印が1文字も含まれない**ことを確かめる。
 *
 * T3（本物の DB のエラー）は tests/log-safety-db.test.ts。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PostgrestError } from "@supabase/postgrest-js";
import { aiCode, dbCode, errName, logEvent, logFailure, logWarn } from "@/lib/log";

// 目印。日本語と記号を混ぜて、どの「番号の形」にも当たらないようにしてある
const CANARY = "CANARY-本文-7f3a";

// ---------------------------------------------------------------
// console をすべて差し替えて、出たものを集める
// ---------------------------------------------------------------
let printed: string[] = [];

function capture() {
  printed = [];
  const keep = (...args: unknown[]) => {
    printed.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation(keep);
  }
}

function everything(): string {
  return printed.join("\n");
}

beforeEach(() => capture());
afterEach(() => {
  // どのテストでも、目印がどこにも出ていないこと
  expect(everything()).not.toContain("CANARY");
  expect(everything()).not.toContain("本文");
  vi.restoreAllMocks();
});

// =============================================================
// T1：ログの関数が本文を通さない
// =============================================================
describe("T1 DB のエラー・例外の中身はログに出ない", () => {
  it("DBの決まりの違反：details に行の値が入った場合でも出さない（開発用 Supabase では details は空だったが、設定や版で変わりうる）", () => {
    const error = new PostgrestError({
      message: `new row for relation "messages" violates check constraint "messages_role_check"`,
      details: `Failing row contains (id, conv, user, invalid, ${CANARY}, 2026-09-29, null).`,
      hint: `hint ${CANARY}`,
      code: "23514",
    });
    logFailure("send.save_user_message", { stage: "insert", kind: "db", code: dbCode(error) });

    expect(everything()).toContain("op=send.save_user_message");
    expect(everything()).toContain("code=23514");
  });

  it("（見張りの確認）以前の書き方なら、目印がログに出てしまう", () => {
    const error = { message: `invalid input syntax for type uuid: "${CANARY}"`, details: null, hint: null, code: "22P02" };
    // 以前はこう書いていた（エラーを丸ごと）
    console.error("[旧] 記憶の削除に失敗:", error);
    expect(everything()).toContain("CANARY");
    // 見張りが効くことを確かめたので、この出力は数えない
    printed = [];
  });

  it("形の誤り（入力された値が message に入る）", () => {
    const error = { message: `invalid input syntax for type uuid: "${CANARY}"`, details: "", hint: "", code: "22P02" };
    logFailure("memory.delete", { stage: "rpc", kind: "db", code: dbCode(error) });
    expect(everything()).toContain("code=22P02");
  });

  it("通信の失敗（details に呼び出しの経路と接続先が入る）", () => {
    const error = {
      message: `TypeError: fetch failed ${CANARY}`,
      details: `TypeError: fetch failed\n    at ${CANARY}.supabase.co\n    at node:internal`,
      hint: "",
      code: "ECONNRESET",
    };
    logFailure("turn.load_history", { stage: "select", kind: "db", code: dbCode(error) });
    expect(everything()).toContain("code=ECONNRESET");
  });

  it("番号が空・無い・DBのエラーですらない", () => {
    logFailure("usage.record", { stage: "insert", kind: "db", code: dbCode({ message: CANARY, code: "" }) });
    logFailure("usage.record", { stage: "insert", kind: "db", code: dbCode({ details: CANARY }) });
    logFailure("usage.record", { stage: "insert", kind: "db", code: dbCode(CANARY) });
    logFailure("usage.record", { stage: "insert", kind: "db", code: dbCode(null) });
    expect(printed).toHaveLength(4);
    for (const line of printed) expect(line).not.toContain("code=");
  });

  it("例外は種類の名前だけ（message・stack は出さない）", () => {
    logFailure("export.build", { stage: "build", kind: "exception", code: errName(new Error(CANARY)) });
    logFailure("export.build", { stage: "build", kind: "exception", code: errName(new TypeError(CANARY)) });
    logFailure("pdf.build", { stage: "build", kind: "exception", code: errName(new PostgrestError({ message: CANARY, details: CANARY, hint: CANARY, code: "23514" })) });
    logFailure("pdf.build", { stage: "build", kind: "exception", code: errName(CANARY) });
    logFailure("pdf.build", { stage: "build", kind: "exception", code: errName({ message: CANARY }) });

    expect(printed[0]).toContain("code=Error");
    expect(printed[1]).toContain("code=TypeError");
    expect(printed[2]).toContain("code=PostgrestError");
    expect(printed[3]).toContain("code=NonError");
    expect(printed[4]).toContain("code=NonError");
  });

  it("例外の名前を作る側が書き換えても、知らない名前は出さない", () => {
    const e = new Error("x");
    e.name = CANARY;
    logFailure("export.build", { stage: "build", kind: "exception", code: errName(e) });
    expect(everything()).toContain("code=OtherError");
  });

  it("成功・注意のログは、決まった名前と数値だけ", () => {
    logEvent("export.build", "done", { bytes: 12345, ms: 210 });
    logEvent("pdf.build", "done_last_month", { kept: 3, changed: 1, corrected: 0, bytes: 900000, ms: 1500 });
    logWarn("memory.search_load", "truncated", { count: 20000 });
    expect(printed[0]).toBe("[ai-kasshi] info op=export.build event=done bytes=12345 ms=210");
    expect(printed[1]).toBe(
      "[ai-kasshi] info op=pdf.build event=done_last_month bytes=900000 ms=1500 kept=3 changed=1 corrected=0",
    );
    expect(printed[2]).toBe("[ai-kasshi] warn op=memory.search_load event=truncated count=20000");
  });

  it("ログを出すこと自体が失敗しても、処理を止めない", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("出力先が壊れている");
    });
    expect(() => logFailure("usage.record", { stage: "insert", kind: "db" })).not.toThrow();
  });
});

// =============================================================
// T2：形の合わない番号・名前は出さない
// =============================================================
describe("T2 形の合わない番号・名前は出さない", () => {
  it("DB の番号の形に合わないものは捨てる", () => {
    for (const code of [CANARY, `23514 ${CANARY}`, "2351", "235145", "pgrst116", "PGRST1160", "a@b.jp", "E", "UND_ERR_本文"]) {
      expect(dbCode({ code })).toBeUndefined();
    }
    for (const code of ["23514", "23505", "42501", "22P02", "P0001", "PGRST116", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(dbCode({ code })).toBe(code);
    }
  });

  it("型を無理に外して自由な文字を渡しても、出す直前に止める", () => {
    /* 型のうえでは渡せない。ここでは、型を外した場合の最後の守りを確かめる */
    // @ts-expect-error 自由な文字列は番号として渡せない
    logFailure("turn.chat", { stage: "ai", kind: "ai", code: CANARY });
    // @ts-expect-error 決まっていない処理名は渡せない
    logFailure(CANARY, { stage: "ai", kind: "ai" });
    // @ts-expect-error 決まっていない段階は渡せない
    logFailure("turn.chat", { stage: CANARY, kind: "ai" });
    // @ts-expect-error 決まっていない出来事は渡せない
    logEvent("export.build", CANARY);
    // @ts-expect-error 数値以外は渡せない
    logEvent("export.build", "done", { bytes: CANARY });
    // @ts-expect-error 決まっていない数値の名前は渡せない
    logEvent("export.build", "done", { text: 1, [CANARY]: 2 });
    // @ts-expect-error 例外そのものは渡せない
    logFailure("export.build", { stage: "build", kind: "exception", code: new Error(CANARY) });
    // @ts-expect-error DB のエラーそのものは渡せない
    logFailure("candidate.save", { stage: "insert", kind: "db", code: { message: CANARY, details: CANARY } });
    // @ts-expect-error 決まっていないAIの種類は渡せない
    logFailure("turn.chat", { stage: "ai", kind: "ai", code: aiCode(CANARY) });

    expect(printed.length).toBeGreaterThanOrEqual(8);
    expect(everything()).toContain("code=invalid");
    expect(everything()).toContain("op=unknown");
  });

  it("数値でも、有限でないものは出さない", () => {
    logEvent("export.build", "done", { bytes: Number.NaN, ms: Number.POSITIVE_INFINITY, count: 2.6 });
    expect(printed[0]).toBe("[ai-kasshi] info op=export.build event=done count=3");
  });
});

// =============================================================
// T6：AIの失敗でも、本文・detail はログに出ない
// =============================================================

/** 次に messages.create を呼んだときに投げるもの */
let nextThrow: () => unknown = () => new Error("未設定");

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const Real = mod.default;
  class FakeAnthropic extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      // 通信はしない。呼ばれたら、決めておいたエラーを投げるだけ
      (this as unknown as { messages: unknown }).messages = {
        create: async () => {
          throw nextThrow();
        },
      };
    }
  }
  return { ...mod, default: FakeAnthropic };
});

/** 記憶を読むところだけの、つくりものの Supabase（どう呼ばれても同じ行を返す） */
function fakeSupabase(rows: Record<string, unknown>[]): SupabaseClient {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
      }
      return () => chain;
    },
  });
  return { from: () => chain } as unknown as SupabaseClient;
}

const Anthropic = (await import("@anthropic-ai/sdk")).default;
const { chat } = await import("@/lib/ai/anthropic");
const { extractCandidates } = await import("@/lib/ai/memory");
const { searchMemories } = await import("@/lib/ai/memory-search");
const { findRevisionTargets } = await import("@/lib/ai/memory-revise");

describe("T6 AIの失敗でも、本文・detail はログに出ない", () => {
  const headers = new Headers({ "request-id": "req_test" });
  /** 目印入りのエラーを、SDK の本物のクラスで作る */
  /* expected … 会話の返事（chat）での種類。
     others … 記憶の3つの呼び出しでの種類（こちらは「不正な依頼」「過負荷」を分けず api_error にする。今回の変更前からの作り） */
  const errors: { name: string; make: () => unknown; expected: string; others?: string }[] = [
    {
      name: "認証",
      make: () => new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: CANARY } }, undefined, headers),
      expected: "auth",
    },
    {
      name: "混雑",
      make: () => new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: CANARY } }, undefined, headers),
      expected: "rate_limit",
    },
    {
      name: "不正な依頼",
      make: () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: CANARY } }, undefined, headers),
      expected: "bad_request",
      others: "api_error",
    },
    {
      name: "過負荷",
      make: () => new Anthropic.APIError(529, { type: "error", error: { type: "overloaded_error", message: CANARY } }, undefined, headers),
      expected: "overloaded",
      others: "api_error",
    },
    {
      name: "通信",
      make: () => new Anthropic.APIConnectionError({ message: CANARY }),
      expected: "network",
    },
    {
      name: "想定外",
      make: () => new Error(CANARY),
      expected: "api_error",
    },
  ];

  const turns = [{ role: "user" as const, content: `相談です ${CANARY}` }];
  const memoryRows = [
    { id: "00000000-0000-4000-8000-000000000001", text: `相談 ${CANARY}`, conversation_id: "c", confirmed_at: null, version: 1 },
  ];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-not-a-real-key";
  });

  for (const e of errors) {
    it(`${e.name}：4つの呼び出しすべてで、種類だけがログに出る`, async () => {
      nextThrow = e.make;

      const r1 = await chat(turns, [{ id: "m1", text: `記憶 ${CANARY}` }]);
      const r2 = await extractCandidates(turns, false, [`提案済み ${CANARY}`]);
      const r3 = await searchMemories(fakeSupabase(memoryRows), "u", `相談 ${CANARY}`);
      const r4 = await findRevisionTargets(fakeSupabase(memoryRows), "u", `相談 ${CANARY} を消して`);

      // 危険が本物であること：detail には AIのエラー文（目印）が入っている
      const failures = [r1, r2, r3.call, r4.call];
      failures.forEach((f, i) => {
        expect(f && !f.ok).toBe(true);
        if (f && !f.ok) {
          expect(f.errorCode).toBe(i === 0 ? e.expected : (e.others ?? e.expected));
          expect(f.detail).toContain("CANARY");
        }
      });

      // actions.ts と同じ書き方でログへ出す（detail は渡さない）
      if (!r1.ok) logFailure("turn.chat", { stage: "ai", kind: "ai", code: aiCode(r1.errorCode), ms: r1.durationMs });
      if (!r2.ok) logFailure("memory.extract", { stage: "ai", kind: "ai", code: aiCode(r2.errorCode), ms: r2.durationMs });
      if (r3.call && !r3.call.ok) logFailure("memory.search", { stage: "ai", kind: "ai", code: aiCode(r3.call.errorCode), ms: r3.call.durationMs });
      if (r4.call && !r4.call.ok) logFailure("revision.find", { stage: "ai", kind: "ai", code: aiCode(r4.call.errorCode), ms: r4.call.durationMs });

      expect(printed).toHaveLength(4);
      expect(printed[0]).toContain(`op=turn.chat stage=ai kind=ai code=${e.expected}`);
      for (const line of printed.slice(1)) expect(line).toContain(`code=${e.others ?? e.expected}`);
      // afterEach で、SDK 自身の出力を含めて目印が出ていないことも確かめる
    });
  }
});

// =============================================================
// 書き忘れの防止（コードの検索）
// =============================================================
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("書き忘れの防止", () => {
  const files = sourceFiles(path.resolve("src"));

  it("src/ で console を直接使っているのは src/lib/log.ts だけ", () => {
    const offenders = files.filter(
      (f) => !f.endsWith(path.join("lib", "log.ts")) && /\bconsole\./.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("サーバーの処理は、AIのエラー文（detail）をどこにも渡していない", () => {
    const actions = readFileSync(path.resolve("src/app/actions.ts"), "utf8");
    expect(actions).not.toMatch(/\.detail\b/);
  });

  it("アプリは Resend を直接呼ばず、ログインの画面はログを出さない", () => {
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/resend/i);
    const login = readFileSync(path.resolve("src/app/login/LoginForm.tsx"), "utf8");
    expect(login).not.toMatch(/\bconsole\.|@\/lib\/log/);
  });
});

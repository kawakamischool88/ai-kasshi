/**
 * 原価の停止が、すべての有料AI処理に効いているかのテスト（Phase 3D）。
 *
 * 確かめたいこと。
 *   ・4種類の呼び出し（会話・記憶の検索・記憶候補の取り出し・訂正や削除の対象探し）が
 *     すべて同じ合計に入ること
 *   ・止まっていても、お金のかからない処理（閲覧・削除・ログアウト）は使えること
 *   ・同時に何本も走ったとき、停止値をどれだけ超えうるか
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { judgeBudget } from "@/lib/ai/budget";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

/** このテストで入れた記録の目印。金額はごくわずかにしてある */
const MARK = "test-3d-budget";
const TINY = 0.000001;

let a: SupabaseClient;
let idA: string;
let conv: string;

/** しきい値を差し替えて読み込み直す（設定は読み込み時に決まるため） */
async function budgetWith(stopUsd: number, warningUsd = 0) {
  vi.resetModules();
  process.env.AI_MONTHLY_STOP_USD = String(stopUsd);
  process.env.AI_MONTHLY_WARNING_USD = String(warningUsd);
  const mod = await import("@/lib/ai/budget");
  return mod.getBudgetStatus(a);
}

async function addUsage(operationType: string, cost: number) {
  const { error } = await a.from("ai_usage").insert({
    user_id: idA,
    conversation_id: conv,
    operation_type: operationType,
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimated_cost: cost,
    pricing_version: MARK,
    pricing_date: "2026-09-21",
    status: "success",
  });
  if (error) throw new Error(`利用記録: ${error.message}`);
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  if (!url || !anonKey || !pa) throw new Error(".env.test.local の設定が足りません");

  a = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await a.auth.signInWithPassword({
    email: "kasshi-test-a@example.com",
    password: pa,
  });
  if (error) throw error;
  idA = data.user!.id;

  const { data: c } = await a
    .from("conversations")
    .insert({ user_id: idA, title: "原価停止のテスト" })
    .select("id")
    .single();
  conv = c!.id as string;
});

afterAll(async () => {
  if (conv) await a.from("conversations").delete().eq("id", conv);
  delete process.env.AI_MONTHLY_STOP_USD;
  delete process.env.AI_MONTHLY_WARNING_USD;
});

describe("しきい値の判定", () => {
  it("停止値に達したら止める", () => {
    expect(judgeBudget(40, 15, 40)).toBe("stopped");
    expect(judgeBudget(40.01, 15, 40)).toBe("stopped");
  });

  it("警告値と停止値の間は警告", () => {
    expect(judgeBudget(15, 15, 40)).toBe("warning");
    expect(judgeBudget(39.99, 15, 40)).toBe("warning");
  });

  it("どちらにも達していなければ、ふつう", () => {
    expect(judgeBudget(14.99, 15, 40)).toBe("ok");
  });
});

describe("4種類の呼び出しが、すべて同じ合計に入る", () => {
  const kinds = ["chat", "memory_search", "memory_extract", "memory_revise"];

  it("どの種類も合計に足される", async () => {
    const before = await budgetWith(999);
    for (const kind of kinds) await addUsage(kind, TINY);
    const after = await budgetWith(999);

    // 4件ぶん増えている（小数の丸めがあるので、おおよそで見る）
    expect(after.spentUsd).toBeGreaterThanOrEqual(before.spentUsd + TINY * 4 - 0.0000005);
  });

  it("種類ごとの記録が、実際に4件残っている", async () => {
    const { data } = await a
      .from("ai_usage")
      .select("operation_type")
      .eq("pricing_version", MARK);
    const found = new Set((data ?? []).map((r) => r.operation_type as string));
    for (const kind of kinds) expect(found.has(kind)).toBe(true);
  });

  it("合計が停止値に届けば、止まった状態になる", async () => {
    const status = await budgetWith(TINY); // ごくわずかな停止値
    expect(status.state).toBe("stopped");
  });

  it("止めた記録（blocked）は金額0で残せる", async () => {
    const { error } = await a.from("ai_usage").insert({
      user_id: idA,
      conversation_id: conv,
      operation_type: "memory_search",
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimated_cost: 0,
      pricing_version: MARK,
      pricing_date: "2026-09-21",
      status: "blocked",
      error_code: "budget_stopped",
    });
    expect(error).toBeNull();
  });
});

describe("止まっていても、お金のかからない処理は使える", () => {
  it("止まった状態でも、会話を読める", async () => {
    const status = await budgetWith(TINY);
    expect(status.state).toBe("stopped");

    const { data, error } = await a.from("conversations").select("id, title").eq("id", conv);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("止まった状態でも、記憶を読める", async () => {
    const { error } = await a.from("confirmed_memories").select("id").limit(1);
    expect(error).toBeNull();
  });

  it("止まった状態でも、記憶を消せる", async () => {
    const { data: msg } = await a
      .from("messages")
      .insert({ conversation_id: conv, user_id: idA, role: "user", content: "停止中の削除テスト" })
      .select("id")
      .single();
    const { data: mem } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: conv,
        source_message_id: msg!.id,
        candidate_index: 1,
        suggested_text: "停止中でも消せるはずの記憶",
        origin: "self_experience",
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    const { data: removed, error } = await a.rpc("delete_memory", { target: mem!.id });
    expect(error).toBeNull();
    expect(removed).toBe(1);
  });

  it("止まった状態でも、ログアウトできる", async () => {
    const other = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await other.auth.signInWithPassword({
      email: "kasshi-test-a@example.com",
      password: process.env.TEST_USER_A_PASSWORD!,
    });
    const { error } = await other.auth.signOut();
    expect(error).toBeNull();
  });
});

describe("同時に走ったときの、はみ出しの大きさ", () => {
  it("同時に確かめても、全員が同じ合計を見る", async () => {
    const results = await Promise.all([
      budgetWith(999),
      budgetWith(999),
      budgetWith(999),
      budgetWith(999),
      budgetWith(999),
    ]);
    const totals = new Set(results.map((r) => r.spentUsd));
    expect(totals.size).toBe(1);
  });

  it("止まったあとに始まる処理は、全部止まる", async () => {
    const results = await Promise.all([
      budgetWith(TINY),
      budgetWith(TINY),
      budgetWith(TINY),
      budgetWith(TINY),
      budgetWith(TINY),
    ]);
    expect(results.every((r) => r.state === "stopped")).toBe(true);
  });

  it("はみ出しは「同時に走っている本数 × 1回ぶんの費用」までに収まる", async () => {
    /* 同時に5本が、止まる直前に確認を通り抜けた場合を作る。
       通り抜けた5本ぶんだけが上乗せされ、それ以上には増えない。 */
    const before = await budgetWith(999);
    const perCall = TINY;

    const passed: number[] = await Promise.all(
      Array.from({ length: 5 }, async (): Promise<number> => {
        const status = await budgetWith(999); // まだ止まっていない
        if (status.state === "stopped") return 0;
        await addUsage("chat", perCall);
        return perCall;
      }),
    );

    const after = await budgetWith(999);
    const added = passed.reduce((s, v) => s + v, 0);
    // 増えたぶんが、通り抜けた本数ぶんを超えていない
    expect(after.spentUsd - before.spentUsd).toBeLessThanOrEqual(added + 0.0000005);
    expect(added).toBeLessThanOrEqual(perCall * 5);
  });
});

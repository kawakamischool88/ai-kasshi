/**
 * 確定記憶の検索・出典についての越境アクセス拒否テスト（Phase 3B）。
 *
 * 「検索結果そのもの」が他人の記憶を含まないことと、
 * 未確定・却下・期限切れが検索対象に入らないことを確かめる。
 * アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const PERMISSION_DENIED = "42501";

function newClient(): SupabaseClient {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { client, userId: data.user!.id };
}

type Seeded = {
  conversationId: string;
  messageId: string;
  assistantMessageId: string;
  confirmed: string;
  pending: string;
  rejected: string;
  expired: string;
};

let a: SupabaseClient;
let b: SupabaseClient;
let anon: SupabaseClient;
let idA: string;
let idB: string;
let A: Seeded;
let B: Seeded;

/** 4つの状態の記憶を1組ずつ作る */
async function seed(client: SupabaseClient, userId: string, label: string): Promise<Seeded> {
  const { data: conv, error: e1 } = await client
    .from("conversations")
    .insert({ user_id: userId, title: `${label}の会話（検索テスト）` })
    .select("id")
    .single();
  if (e1) throw new Error(`会話 ${label}: ${e1.message}`);

  const { data: msg, error: e2 } = await client
    .from("messages")
    .insert({ conversation_id: conv.id, user_id: userId, role: "user", content: `${label}の発言` })
    .select("id")
    .single();
  if (e2) throw new Error(`発言 ${label}: ${e2.message}`);

  const { data: reply, error: e3 } = await client
    .from("messages")
    .insert({ conversation_id: conv.id, user_id: userId, role: "assistant", content: `${label}への返事` })
    .select("id")
    .single();
  if (e3) throw new Error(`返事 ${label}: ${e3.message}`);

  // 同じ発言からは2件までなので、状態ごとに別の発言を出典にする
  const make = async (index: number, text: string, patch: Record<string, unknown>) => {
    const { data: src } = await client
      .from("messages")
      .insert({ conversation_id: conv.id, user_id: userId, role: "user", content: `${label}の発言${index}` })
      .select("id")
      .single();
    const { data, error } = await client
      .from("memory_candidates")
      .insert({
        user_id: userId,
        conversation_id: conv.id,
        source_message_id: src!.id,
        candidate_index: 1,
        suggested_text: text,
        origin: "self_experience",
        ...patch,
      })
      .select("id")
      .single();
    if (error) throw new Error(`候補 ${label}/${index}: ${error.message}`);
    return data.id as string;
  };

  const past = new Date(Date.now() - 1000).toISOString();
  return {
    conversationId: conv.id as string,
    messageId: msg.id as string,
    assistantMessageId: reply.id as string,
    confirmed: await make(1, `${label}の確定記憶`, {
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    }),
    pending: await make(2, `${label}の未確定の候補`, { status: "pending" }),
    rejected: await make(3, `${label}の却下した候補`, { status: "rejected" }),
    expired: await make(4, `${label}の期限切れの候補`, { status: "expired", expires_at: past }),
  };
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");

  ({ client: a, userId: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ client: b, userId: idB } = await signIn("kasshi-test-b@example.com", pb));
  anon = newClient();

  A = await seed(a, idA, "A");
  B = await seed(b, idB, "B");
});

afterAll(async () => {
  if (A?.conversationId) await a.from("conversations").delete().eq("id", A.conversationId);
  if (B?.conversationId) await b.from("conversations").delete().eq("id", B.conversationId);
});

describe("検索対象は確定記憶だけ", () => {
  it("未確定・却下・期限切れは検索対象に入らない", async () => {
    // アプリと同じ入口（確定済みだけを見せる view）から引く
    const { data, error } = await a.from("confirmed_memories").select("id, text");
    expect(error).toBeNull();

    const ids = (data ?? []).map((r) => r.id as string);
    expect(ids).toContain(A.confirmed);
    expect(ids).not.toContain(A.pending);
    expect(ids).not.toContain(A.rejected);
    expect(ids).not.toContain(A.expired);
  });

  it("確定記憶の一覧には、自分のものしか出てこない", async () => {
    const { data } = await a.from("confirmed_memories").select("user_id, text");
    expect((data ?? []).every((r) => r.user_id === idA)).toBe(true);
    expect((data ?? []).some((r) => (r.text as string).startsWith("B"))).toBe(false);
  });
});

describe("検索結果の越境拒否", () => {
  it("A は B の確定記憶を、idを指定しても取り出せない", async () => {
    const { data, error } = await a.from("confirmed_memories").select("id").eq("id", B.confirmed);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("B は A の確定記憶を、idを指定しても取り出せない", async () => {
    const { data, error } = await b.from("confirmed_memories").select("id").eq("id", A.confirmed);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("A は「相手のuser_idで絞る」やり方でも取り出せない", async () => {
    const { data } = await a.from("confirmed_memories").select("id").eq("user_id", idB);
    expect(data).toEqual([]);
  });

  it("未ログインでは確定記憶を読めない", async () => {
    const { data, error } = await anon.from("confirmed_memories").select("id");
    expect(error?.code === PERMISSION_DENIED || (error === null && data?.length === 0)).toBe(true);
  });
});

describe("出典の越境拒否", () => {
  it("他人の記憶を、自分の返事の出典にできない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idA,
      message_id: A.assistantMessageId,
      memory_id: B.confirmed, // 相手の記憶
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("自分の記憶を、他人の返事の出典にできない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idA,
      message_id: B.assistantMessageId, // 相手の返事
      memory_id: A.confirmed,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("未確定の候補は出典にできない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idA,
      message_id: A.assistantMessageId,
      memory_id: A.pending, // まだ本人が確定していない
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("却下した候補は出典にできない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idA,
      message_id: A.assistantMessageId,
      memory_id: A.rejected,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("相手名義では出典を作れない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idB,
      message_id: A.assistantMessageId,
      memory_id: A.confirmed,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("A は B の出典を読めない", async () => {
    await b.from("memory_references").insert({
      user_id: idB,
      message_id: B.assistantMessageId,
      memory_id: B.confirmed,
    });
    const { data } = await a.from("memory_references").select("user_id");
    expect((data ?? []).every((r) => r.user_id === idA)).toBe(true);
  });

  it("未ログインでは出典を読めない", async () => {
    const { data, error } = await anon.from("memory_references").select("id");
    expect(error?.code === PERMISSION_DENIED || (error === null && data?.length === 0)).toBe(true);
  });
});

describe("正常系（テストが本当に効いているかの確認）", () => {
  it("自分の確定記憶を、自分の返事の出典にできる", async () => {
    const { data, error } = await a
      .from("memory_references")
      .insert({ user_id: idA, message_id: A.assistantMessageId, memory_id: A.confirmed })
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("同じ返事に同じ記憶を二重に記録しない", async () => {
    const { error } = await a
      .from("memory_references")
      .insert({ user_id: idA, message_id: A.assistantMessageId, memory_id: A.confirmed });
    expect(error?.code).toBe("23505");
  });
});

/**
 * 会話・メッセージ・AI利用量についての越境アクセス拒否テスト（Phase 2）。
 *
 * 架空ユーザー A・B でログインし、A→B・B→A の
 * 読取 / 作成 / 更新 / 削除 がすべて通らないことを確かめる。
 * アプリと同じ anon キーで接続する（service_role は使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const EMAIL_A = "kasshi-test-a@example.com";
const EMAIL_B = "kasshi-test-b@example.com";

/** 権限なし。Postgres が返すコード */
const PERMISSION_DENIED = "42501";
/** 一意制約違反。二重送信を止めたときのコード */
const UNIQUE_VIOLATION = "23505";

function newClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signIn(email: string, password: string) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { client, userId: data.user!.id };
}

let a: SupabaseClient;
let b: SupabaseClient;
let anon: SupabaseClient;
let idA: string;
let idB: string;
let convA: string;
let convB: string;
let msgA: string;
let msgB: string;

/** テスト用の会話と発言を1組作る */
async function seedConversation(client: SupabaseClient, userId: string, label: string) {
  const { data: conv, error: e1 } = await client
    .from("conversations")
    .insert({ user_id: userId, title: `${label}の会話（テスト）` })
    .select("id")
    .single();
  if (e1) throw new Error(`会話の作成に失敗 ${label}: ${e1.message}`);

  const { data: msg, error: e2 } = await client
    .from("messages")
    .insert({
      conversation_id: conv.id,
      user_id: userId,
      role: "user",
      content: `${label}の発言（テスト）`,
    })
    .select("id")
    .single();
  if (e2) throw new Error(`発言の作成に失敗 ${label}: ${e2.message}`);

  await client.from("ai_usage").insert({
    user_id: userId,
    conversation_id: conv.id,
    operation_type: "chat",
    provider: "test",
    model: "test-model",
    estimated_cost: 0,
    pricing_version: "test",
    pricing_date: "2026-09-17",
    status: "success",
  });

  return { conversationId: conv.id as string, messageId: msg.id as string };
}

beforeAll(async () => {
  if (!url || !anonKey) throw new Error(".env.test.local に SUPABASE_URL / SUPABASE_ANON_KEY がありません");
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!pa || !pb) throw new Error(".env.test.local にテスト用パスワードがありません");

  ({ client: a, userId: idA } = await signIn(EMAIL_A, pa));
  ({ client: b, userId: idB } = await signIn(EMAIL_B, pb));
  anon = newClient();
  expect(idA).not.toBe(idB);

  ({ conversationId: convA, messageId: msgA } = await seedConversation(a, idA, "A"));
  ({ conversationId: convB, messageId: msgB } = await seedConversation(b, idB, "B"));
});

afterAll(async () => {
  // 後片付け（会話を消すと、ぶら下がる発言も一緒に消える）
  if (convA) await a.from("conversations").delete().eq("id", convA);
  if (convB) await b.from("conversations").delete().eq("id", convB);
});

/** A→B と B→A を同じ内容で回す */
function crossUserSuite(
  label: string,
  me: () => SupabaseClient,
  myId: () => string,
  other: () => SupabaseClient,
  otherId: () => string,
  otherConv: () => string,
  otherMsg: () => string,
) {
  describe(label, () => {
    // ---------- 会話 ----------
    it("会話・読取：相手の会話は見えない（一覧にも出ない）", async () => {
      const { data: byId, error } = await me().from("conversations").select("id").eq("id", otherConv());
      expect(error).toBeNull();
      expect(byId).toEqual([]);

      const { data: all } = await me().from("conversations").select("user_id");
      expect((all ?? []).every((r) => r.user_id === myId())).toBe(true);
    });

    it("会話・作成：相手名義の会話は作れない", async () => {
      const { error } = await me().from("conversations").insert({ user_id: otherId() });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it("会話・更新：相手の会話は書き換えられない（0件）", async () => {
      const { data, error } = await me()
        .from("conversations")
        .update({ title: "書き換え" })
        .eq("id", otherConv())
        .select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("conversations").select("title").eq("id", otherConv()).single();
      expect(check?.title).not.toBe("書き換え");
    });

    it("会話・削除：相手の会話は消せない（0件）", async () => {
      const { data, error } = await me().from("conversations").delete().eq("id", otherConv()).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("conversations").select("id").eq("id", otherConv());
      expect(check).toEqual([{ id: otherConv() }]);
    });

    // ---------- メッセージ ----------
    it("発言・読取：相手の発言は見えない（一覧にも出ない）", async () => {
      const { data: byId, error } = await me().from("messages").select("id").eq("id", otherMsg());
      expect(error).toBeNull();
      expect(byId).toEqual([]);

      const { data: all } = await me().from("messages").select("user_id");
      expect((all ?? []).every((r) => r.user_id === myId())).toBe(true);
    });

    it("発言・作成：相手名義では作れない", async () => {
      const { error } = await me().from("messages").insert({
        conversation_id: otherConv(),
        user_id: otherId(),
        role: "user",
        content: "なりすまし",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it("発言・作成：自分名義でも、相手の会話には混ぜられない", async () => {
      const { error } = await me().from("messages").insert({
        conversation_id: otherConv(),
        user_id: myId(), // 自分名義。ここを許すと他人の会話へ書き込めてしまう
        role: "user",
        content: "割り込み",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);

      const { data: check } = await other().from("messages").select("content").eq("conversation_id", otherConv());
      expect((check ?? []).some((m) => m.content === "割り込み")).toBe(false);
    });

    it("発言・更新：相手の発言は書き換えられない（0件）", async () => {
      const { data, error } = await me()
        .from("messages")
        .update({ content: "改ざん" })
        .eq("id", otherMsg())
        .select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("messages").select("content").eq("id", otherMsg()).single();
      expect(check?.content).not.toBe("改ざん");
    });

    it("発言・削除：相手の発言は消せない（0件）", async () => {
      const { data, error } = await me().from("messages").delete().eq("id", otherMsg()).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("messages").select("id").eq("id", otherMsg());
      expect(check).toEqual([{ id: otherMsg() }]);
    });

    // ---------- AI利用量 ----------
    it("利用量・読取：相手の記録は見えない", async () => {
      const { data, error } = await me().from("ai_usage").select("user_id");
      expect(error).toBeNull();
      expect((data ?? []).every((r) => r.user_id === myId())).toBe(true);
    });

    it("利用量・作成：相手名義では作れない", async () => {
      const { error } = await me().from("ai_usage").insert({
        user_id: otherId(),
        operation_type: "chat",
        provider: "test",
        model: "test-model",
        pricing_version: "test",
        pricing_date: "2026-09-17",
        status: "success",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });
  });
}

crossUserSuite("A → B", () => a, () => idA, () => b, () => idB, () => convB, () => msgB);
crossUserSuite("B → A", () => b, () => idB, () => a, () => idA, () => convA, () => msgA);

describe("未ログイン（anon）", () => {
  it("会話・発言・利用量のいずれも読めない", async () => {
    for (const table of ["conversations", "messages", "ai_usage"]) {
      const { data, error } = await anon.from(table).select("id");
      expect(error?.code === PERMISSION_DENIED || (error === null && data?.length === 0)).toBe(true);
    }
  });

  it("作成できない", async () => {
    const { error } = await anon.from("conversations").insert({ user_id: idA });
    expect(error).not.toBeNull();
  });

  it("更新・削除できない", async () => {
    const { data: u, error: ue } = await anon
      .from("conversations")
      .update({ title: "x" })
      .eq("id", convA)
      .select("id");
    expect(ue !== null || u?.length === 0).toBe(true);

    const { data: d, error: de } = await anon.from("conversations").delete().eq("id", convA).select("id");
    expect(de !== null || d?.length === 0).toBe(true);

    const { data: check } = await a.from("conversations").select("id").eq("id", convA);
    expect(check).toEqual([{ id: convA }]);
  });
});

describe("AI利用量は後から書き換えられない（記録として残す）", () => {
  it("自分の記録でも更新できない", async () => {
    const { data, error } = await a
      .from("ai_usage")
      .update({ estimated_cost: 0 })
      .eq("user_id", idA)
      .select("id");
    // 権限なしエラーか、0件（ポリシーがないため対象にならない）
    expect(error !== null || data?.length === 0).toBe(true);
  });

  it("自分の記録でも削除できない", async () => {
    const before = await a.from("ai_usage").select("id").eq("conversation_id", convA);
    const { data, error } = await a.from("ai_usage").delete().eq("conversation_id", convA).select("id");
    expect(error !== null || data?.length === 0).toBe(true);

    const after = await a.from("ai_usage").select("id").eq("conversation_id", convA);
    expect(after.data?.length).toBe(before.data?.length);
  });
});

describe("二重送信の防止", () => {
  it("同じ送信IDでは2回保存できない", async () => {
    const requestId = crypto.randomUUID();
    const row = {
      conversation_id: convA,
      user_id: idA,
      role: "user" as const,
      content: "二重送信のテスト",
      client_request_id: requestId,
    };

    const first = await a.from("messages").insert(row);
    expect(first.error).toBeNull();

    const second = await a.from("messages").insert(row);
    expect(second.error?.code).toBe(UNIQUE_VIOLATION);

    const { data } = await a.from("messages").select("id").eq("client_request_id", requestId);
    expect(data?.length).toBe(1);
  });
});

describe("正常系（テストが本当に効いているかの確認）", () => {
  it("自分の会話と発言は読める・書ける", async () => {
    const { data: conv } = await a.from("conversations").select("id").eq("id", convA);
    expect(conv).toEqual([{ id: convA }]);

    const { data: msg, error } = await a
      .from("messages")
      .insert({ conversation_id: convA, user_id: idA, role: "assistant", content: "返事（テスト）" })
      .select("id, content")
      .single();
    expect(error).toBeNull();
    expect(msg?.content).toBe("返事（テスト）");
  });

  it("自分の利用量は記録できる", async () => {
    const { error } = await a.from("ai_usage").insert({
      user_id: idA,
      conversation_id: convA,
      operation_type: "chat",
      provider: "test",
      model: "test-model",
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost: 0.0007,
      pricing_version: "test",
      pricing_date: "2026-09-17",
      status: "success",
    });
    expect(error).toBeNull();
  });
});

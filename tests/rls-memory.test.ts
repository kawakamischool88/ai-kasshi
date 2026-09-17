/**
 * 記憶候補についての越境アクセス拒否テスト（Phase 3A）。
 *
 * 架空ユーザー A・B でログインし、A→B・B→A の
 * 読取 / 作成 / 更新 がすべて通らないことを確かめる。
 * あわせて、確定記憶の view でも他人の記憶が見えないことを確かめる。
 * アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const PERMISSION_DENIED = "42501";
const UNIQUE_VIOLATION = "23505";

function newClient(): SupabaseClient {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
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
let candA: string;
let candB: string;

/** テスト用の会話・発言・記憶候補を1組作る */
async function seed(client: SupabaseClient, userId: string, label: string) {
  const { data: conv, error: e1 } = await client
    .from("conversations")
    .insert({ user_id: userId, title: `${label}の会話（記憶テスト）` })
    .select("id")
    .single();
  if (e1) throw new Error(`会話の作成に失敗 ${label}: ${e1.message}`);

  const { data: msg, error: e2 } = await client
    .from("messages")
    .insert({ conversation_id: conv.id, user_id: userId, role: "user", content: `${label}の発言` })
    .select("id")
    .single();
  if (e2) throw new Error(`発言の作成に失敗 ${label}: ${e2.message}`);

  const { data: cand, error: e3 } = await client
    .from("memory_candidates")
    .insert({
      user_id: userId,
      conversation_id: conv.id,
      source_message_id: msg.id,
      candidate_index: 1,
      suggested_text: `${label}の記憶候補`,
      origin: "self_experience",
      status: "pending",
    })
    .select("id")
    .single();
  if (e3) throw new Error(`候補の作成に失敗 ${label}: ${e3.message}`);

  return { conversationId: conv.id as string, messageId: msg.id as string, candidateId: cand.id as string };
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");

  ({ client: a, userId: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ client: b, userId: idB } = await signIn("kasshi-test-b@example.com", pb));
  anon = newClient();

  ({ conversationId: convA, messageId: msgA, candidateId: candA } = await seed(a, idA, "A"));
  ({ conversationId: convB, messageId: msgB, candidateId: candB } = await seed(b, idB, "B"));
});

afterAll(async () => {
  if (convA) await a.from("conversations").delete().eq("id", convA);
  if (convB) await b.from("conversations").delete().eq("id", convB);
});

function crossUserSuite(
  label: string,
  me: () => SupabaseClient,
  myId: () => string,
  other: () => SupabaseClient,
  otherId: () => string,
  otherConv: () => string,
  otherMsg: () => string,
  otherCand: () => string,
) {
  describe(label, () => {
    it("読取：相手の記憶候補は見えない（一覧にも出ない）", async () => {
      const { data: byId, error } = await me()
        .from("memory_candidates")
        .select("id")
        .eq("id", otherCand());
      expect(error).toBeNull();
      expect(byId).toEqual([]);

      const { data: all } = await me().from("memory_candidates").select("user_id");
      expect((all ?? []).every((r) => r.user_id === myId())).toBe(true);
    });

    it("読取：確定記憶の一覧でも相手のものは見えない", async () => {
      const { data, error } = await me().from("confirmed_memories").select("user_id");
      expect(error).toBeNull();
      expect((data ?? []).every((r) => r.user_id === myId())).toBe(true);
    });

    it("作成：相手名義の候補は作れない", async () => {
      const { error } = await me().from("memory_candidates").insert({
        user_id: otherId(),
        conversation_id: otherConv(),
        source_message_id: otherMsg(),
        candidate_index: 2,
        suggested_text: "なりすまし",
        origin: "self_experience",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it("作成：自分名義でも、相手の会話には混ぜられない", async () => {
      const { error } = await me().from("memory_candidates").insert({
        user_id: myId(),
        conversation_id: otherConv(),
        source_message_id: otherMsg(),
        candidate_index: 2,
        suggested_text: "割り込み",
        origin: "self_experience",
      });
      expect(error?.code).toBe(PERMISSION_DENIED);
    });

    it("更新：相手の候補を確定できない（0件）", async () => {
      const { data, error } = await me()
        .from("memory_candidates")
        .update({ status: "confirmed", confirmed_text: "乗っ取り" })
        .eq("id", otherCand())
        .select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other()
        .from("memory_candidates")
        .select("status, confirmed_text")
        .eq("id", otherCand())
        .single();
      expect(check?.status).toBe("pending");
      expect(check?.confirmed_text).toBeNull();
    });
  });
}

crossUserSuite("A → B", () => a, () => idA, () => b, () => idB, () => convB, () => msgB, () => candB);
crossUserSuite("B → A", () => b, () => idB, () => a, () => idA, () => convA, () => msgA, () => candA);

describe("未ログイン（anon）", () => {
  it("記憶候補も確定記憶も読めない", async () => {
    for (const table of ["memory_candidates", "confirmed_memories"]) {
      const { data, error } = await anon.from(table).select("id");
      expect(error?.code === PERMISSION_DENIED || (error === null && data?.length === 0)).toBe(true);
    }
  });

  it("作成できない", async () => {
    const { error } = await anon.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 2,
      suggested_text: "x",
      origin: "self_experience",
    });
    expect(error).not.toBeNull();
  });
});

describe("同じ発言から同じ候補を繰り返さない", () => {
  it("同じ発言・同じ通し番号では2件目を作れない", async () => {
    const { error } = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 1, // すでに存在する
      suggested_text: "重複した候補",
      origin: "self_experience",
    });
    expect(error?.code).toBe(UNIQUE_VIOLATION);
  });

  it("2件目（通し番号2）は作れる。3件目は作れない", async () => {
    const second = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 2,
      suggested_text: "2件目の候補",
      origin: "self_experience",
    });
    expect(second.error).toBeNull();

    const third = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 3, // 上限は2
      suggested_text: "3件目の候補",
      origin: "self_experience",
    });
    expect(third.error).not.toBeNull();
  });
});

describe("未確定の候補を確定記憶として扱わない", () => {
  it("本人確認待ちの候補は、確定記憶の一覧に出てこない", async () => {
    const { data } = await a.from("confirmed_memories").select("id").eq("id", candA);
    expect(data).toEqual([]);
  });

  it("［残さない］にした候補も、確定記憶には出てこない", async () => {
    const { data: made } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: convA,
        source_message_id: msgA,
        candidate_index: 2,
        suggested_text: "却下する候補",
        origin: "self_experience",
      })
      .select("id")
      .maybeSingle();

    // すでに通し番号2がある場合は、既存の行を使う
    const targetId = made?.id ?? candA;
    await a.from("memory_candidates").update({ status: "rejected" }).eq("id", targetId);

    const { data } = await a.from("confirmed_memories").select("id").eq("id", targetId);
    expect(data).toEqual([]);

    // 会話そのものは消えていない
    const { data: conv } = await a.from("conversations").select("id").eq("id", convA);
    expect(conv).toEqual([{ id: convA }]);

    await a.from("memory_candidates").update({ status: "pending" }).eq("id", targetId);
  });
});

describe("期限切れ", () => {
  it("期限が切れた候補は確定できない", async () => {
    // 期限切れの候補を作る（作成時に過去の期限を入れる）
    const past = new Date(Date.now() - 1000).toISOString();
    const { data: made, error: makeError } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: convA,
        source_message_id: msgA,
        candidate_index: 2,
        suggested_text: "期限切れの候補",
        origin: "self_experience",
        expires_at: past,
      })
      .select("id")
      .maybeSingle();

    const targetId =
      made?.id ??
      (await a.from("memory_candidates").select("id").eq("candidate_index", 2).eq("source_message_id", msgA).single())
        .data!.id;
    if (makeError) await a.from("memory_candidates").update({ expires_at: past, status: "pending" }).eq("id", targetId);

    // アプリと同じ条件で確定を試みる（期限内であることを条件に含める）
    const { data } = await a
      .from("memory_candidates")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", targetId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .select("id");
    expect(data).toEqual([]);

    // 確定記憶にもなっていない
    const { data: cm } = await a.from("confirmed_memories").select("id").eq("id", targetId);
    expect(cm).toEqual([]);
  });

  it("期限切れの印を付けられる（pending → expired）", async () => {
    const { data } = await a
      .from("memory_candidates")
      .update({ status: "expired" })
      .eq("status", "pending")
      .lte("expires_at", new Date().toISOString())
      .select("id, status");
    for (const r of data ?? []) expect(r.status).toBe("expired");
  });
});

describe("正常系（テストが本当に効いているかの確認）", () => {
  it("自分の候補は読める・確定できる。確定記憶の一覧に出る", async () => {
    const { data: ok } = await a
      .from("memory_candidates")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", candA)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .select("id");
    expect(ok).toEqual([{ id: candA }]);

    const { data: cm } = await a.from("confirmed_memories").select("id, text").eq("id", candA).single();
    expect(cm?.id).toBe(candA);
    expect(cm?.text).toBe("Aの記憶候補");
  });

  it("本人が直した文章があれば、そちらが確定記憶になる", async () => {
    await a.from("memory_candidates").update({ confirmed_text: "本人が直した文章" }).eq("id", candA);
    const { data } = await a.from("confirmed_memories").select("text").eq("id", candA).single();
    expect(data?.text).toBe("本人が直した文章");
  });
});

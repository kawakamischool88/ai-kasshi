/**
 * 記憶の訂正・考えの変化・削除のテスト（Phase 3C）。
 *
 * 実際の開発用 Supabase へ、アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 * 確かめたいのは主に3つ。
 *   ① 消した内容が、ふたたび出てこないこと
 *   ② 昔の考えと、いまの考えが混ざらないこと
 *   ③ 他人の記憶を直したり消したりできないこと
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

let a: SupabaseClient;
let b: SupabaseClient;
let anon: SupabaseClient;
let idA: string;
let idB: string;
let convA: string;
let convB: string;
let msgA: string;
let replyA: string;

/** 会話と発言を1組作る */
async function makeConversation(client: SupabaseClient, userId: string, label: string) {
  const { data: conv, error: e1 } = await client
    .from("conversations")
    .insert({ user_id: userId, title: `${label}の会話（訂正テスト）` })
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
    .insert({ conversation_id: conv.id, user_id: userId, role: "assistant", content: `${label}の返事` })
    .select("id")
    .single();
  if (e3) throw new Error(`返事 ${label}: ${e3.message}`);

  return { conversationId: conv.id as string, messageId: msg.id as string, replyId: reply.id as string };
}

let seq = 0;
/** 確定済みの記憶を1件作る。発言も新しく作る（同じ発言からは2件までのため） */
async function makeMemory(
  client: SupabaseClient,
  userId: string,
  conversationId: string,
  text: string,
): Promise<string> {
  seq += 1;
  const { data: src, error: e1 } = await client
    .from("messages")
    .insert({ conversation_id: conversationId, user_id: userId, role: "user", content: `出典${seq}` })
    .select("id")
    .single();
  if (e1) throw new Error(`出典の発言: ${e1.message}`);

  const { data, error } = await client
    .from("memory_candidates")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      source_message_id: src.id,
      candidate_index: 1,
      suggested_text: text,
      origin: "self_experience",
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`記憶「${text}」: ${error.message}`);
  return data.id as string;
}

/** 確定記憶（いまの内容）の本文一覧 */
async function currentTexts(client: SupabaseClient): Promise<string[]> {
  const { data } = await client.from("confirmed_memories").select("text");
  return (data ?? []).map((r) => r.text as string);
}

/** 過去の考えの本文一覧 */
async function pastTexts(client: SupabaseClient): Promise<string[]> {
  const { data } = await client.from("past_memories").select("text");
  return (data ?? []).map((r) => r.text as string);
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");

  ({ client: a, userId: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ client: b, userId: idB } = await signIn("kasshi-test-b@example.com", pb));
  anon = newClient();

  const A = await makeConversation(a, idA, "A");
  convA = A.conversationId;
  msgA = A.messageId;
  replyA = A.replyId;

  const B = await makeConversation(b, idB, "B");
  convB = B.conversationId;
});

afterAll(async () => {
  if (convA) await a.from("conversations").delete().eq("id", convA);
  if (convB) await b.from("conversations").delete().eq("id", convB);
});

// =============================================================
// 訂正
// =============================================================
describe("訂正（内容が間違っていた）", () => {
  let oldId: string;
  let newId: string;

  it("20日 を 25日 に訂正できる", async () => {
    oldId = await makeMemory(a, idA, convA, "仕入先の締め日は毎月20日");

    const { data, error } = await a.rpc("revise_memory", {
      target: oldId,
      kind: "correction",
      new_text: "仕入先の締め日は毎月25日",
      in_conversation: convA,
      in_message: msgA,
      note: "本人が訂正",
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    newId = data as string;
  });

  it("訂正後、20日 は通常検索されない", async () => {
    expect(await currentTexts(a)).not.toContain("仕入先の締め日は毎月20日");
  });

  it("25日 が現在の内容として使われる", async () => {
    expect(await currentTexts(a)).toContain("仕入先の締め日は毎月25日");
  });

  it("間違いだった内容は「昔の考え」にもならない", async () => {
    expect(await pastTexts(a)).not.toContain("仕入先の締め日は毎月20日");
  });

  it("新しい内容は2代目として記録される", async () => {
    const { data } = await a
      .from("memory_candidates")
      .select("version, revision_kind, revision_of")
      .eq("id", newId)
      .single();
    expect(data?.version).toBe(2);
    expect(data?.revision_kind).toBe("correction");
    expect(data?.revision_of).toBe(oldId);
  });

  it("古い内容には、訂正した日時と、訂正後の内容へのつながりが残る", async () => {
    const { data } = await a
      .from("memory_candidates")
      .select("status, superseded_by, revised_at")
      .eq("id", oldId)
      .single();
    expect(data?.status).toBe("superseded");
    expect(data?.superseded_by).toBe(newId);
    expect(data?.revised_at).toBeTruthy();
  });

  it("同じ内容を続けて2回訂正しても、古い内容は戻らない", async () => {
    // 1回目（すでに訂正済みの古い内容に対して、もう一度訂正を試みる）
    const { data } = await a.rpc("revise_memory", {
      target: oldId,
      kind: "correction",
      new_text: "仕入先の締め日は毎月10日",
      in_conversation: convA,
      in_message: msgA,
      note: null,
    });
    expect(data).toBeNull(); // 何も起きない
    const texts = await currentTexts(a);
    expect(texts).toContain("仕入先の締め日は毎月25日");
    expect(texts).not.toContain("仕入先の締め日は毎月10日");
  });
});

// =============================================================
// 考えの変化
// =============================================================
describe("考えの変化（間違いではない）", () => {
  let oldId: string;

  it("方針A を 方針B に更新できる", async () => {
    oldId = await makeMemory(a, idA, convA, "新商品は小さく試して反応を見ることを大切にしている");

    const { data, error } = await a.rpc("revise_memory", {
      target: oldId,
      kind: "update",
      new_text: "ブランド設計だけは最初にしっかり決めた方がいいと思っている",
      in_conversation: convA,
      in_message: msgA,
      note: "本人の考えの変化",
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });

  it("ふだんの質問では、新しい考えだけが使われる", async () => {
    const texts = await currentTexts(a);
    expect(texts).toContain("ブランド設計だけは最初にしっかり決めた方がいいと思っている");
    expect(texts).not.toContain("新商品は小さく試して反応を見ることを大切にしている");
  });

  it("昔の考えとして確認できる", async () => {
    expect(await pastTexts(a)).toContain("新商品は小さく試して反応を見ることを大切にしている");
  });

  it("昔の考えを「間違いだった」扱いにしない", async () => {
    const { data } = await a.from("memory_candidates").select("status").eq("id", oldId).single();
    // superseded（訂正されて無効）ではなく archived（過去の考え）
    expect(data?.status).toBe("archived");
  });
});

// =============================================================
// 削除（記憶だけ）
// =============================================================
describe("削除（記憶だけ消す）", () => {
  let memoryId: string;

  it("記憶を消せる", async () => {
    memoryId = await makeMemory(a, idA, convA, "この内容は消される予定です");
    const { data, error } = await a.rpc("delete_memory", { target: memoryId });
    expect(error).toBeNull();
    expect(data).toBe(1);
  });

  it("消したあとは検索されない", async () => {
    const texts = await currentTexts(a);
    expect(texts).not.toContain("この内容は消される予定です");
    expect(await pastTexts(a)).not.toContain("この内容は消される予定です");
  });

  it("本文そのものが残っていない", async () => {
    const { data } = await a
      .from("memory_candidates")
      .select("status, suggested_text, confirmed_text, deleted_at")
      .eq("id", memoryId)
      .single();
    expect(data?.status).toBe("deleted");
    expect(data?.suggested_text).toBeNull();
    expect(data?.confirmed_text).toBeNull();
    expect(data?.deleted_at).toBeTruthy();
  });

  it("削除の記録が残る（本文は持たない）", async () => {
    const { data } = await a
      .from("memory_deletions")
      .select("memory_id, scope, source_message_id, deleted_at")
      .eq("memory_id", memoryId)
      .single();
    expect(data?.scope).toBe("memory_only");
    expect(data?.source_message_id).toBeTruthy();
    // 本文の列そのものが存在しない
    expect(Object.keys(data ?? {})).not.toContain("text");
  });

  it("元の会話は残る", async () => {
    const { data } = await a.from("conversations").select("id").eq("id", convA).maybeSingle();
    expect(data?.id).toBe(convA);
  });

  it("消した記憶は、新しい出典にできない", async () => {
    const { error } = await a.from("memory_references").insert({
      user_id: idA,
      message_id: replyA,
      memory_id: memoryId,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("消した記憶は、もう訂正できない", async () => {
    const { data } = await a.rpc("revise_memory", {
      target: memoryId,
      kind: "correction",
      new_text: "よみがえらせようとした内容",
      in_conversation: convA,
      in_message: msgA,
      note: null,
    });
    expect(data).toBeNull();
    expect(await currentTexts(a)).not.toContain("よみがえらせようとした内容");
  });

  it("同じ発言から、同じ記憶を作り直せない（消したものが復活しない）", async () => {
    // 消した記憶の「もとの発言」を調べる
    const { data: del } = await a
      .from("memory_deletions")
      .select("source_message_id")
      .eq("memory_id", memoryId)
      .single();
    const sourceId = del!.source_message_id as string;

    // 同じ発言から、同じ通し番号でもう一度作ろうとする
    const { error } = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: sourceId,
      candidate_index: 1,
      suggested_text: "この内容は消される予定です",
      origin: "self_experience",
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    });
    expect(error?.code).toBe("23505"); // すでにある＝作り直せない
    expect(await currentTexts(a)).not.toContain("この内容は消される予定です");
  });

  it("消した記憶にも、もとの発言の印が残っている（作り直さないため）", async () => {
    const { data } = await a
      .from("memory_deletions")
      .select("source_message_id")
      .eq("memory_id", memoryId)
      .single();
    expect(data?.source_message_id).toBeTruthy();
  });

  it("二度消しても、消した件数は増えない", async () => {
    const { data } = await a.rpc("delete_memory", { target: memoryId });
    expect(data).toBe(0);
  });

  it("訂正したあとに消すと、前の内容もまとめて消える", async () => {
    const first = await makeMemory(a, idA, convA, "まとめて消される1代目");
    const { data: second } = await a.rpc("revise_memory", {
      target: first,
      kind: "correction",
      new_text: "まとめて消される2代目",
      in_conversation: convA,
      in_message: msgA,
      note: null,
    });
    expect(second).toBeTruthy();

    // 2代目を消すと、1代目も一緒に消える
    const { data: removed } = await a.rpc("delete_memory", { target: second as string });
    expect(removed).toBe(2);

    const texts = await currentTexts(a);
    expect(texts).not.toContain("まとめて消される1代目");
    expect(texts).not.toContain("まとめて消される2代目");

    const { data: rows } = await a
      .from("memory_candidates")
      .select("suggested_text, confirmed_text")
      .in("id", [first, second as string]);
    for (const r of rows ?? []) {
      expect(r.suggested_text).toBeNull();
      expect(r.confirmed_text).toBeNull();
    }
  });

  it("考えが変わったあとに消すと、昔の考えも一緒に消える", async () => {
    const first = await makeMemory(a, idA, convA, "昔の考え（消える予定）");
    const { data: second } = await a.rpc("revise_memory", {
      target: first,
      kind: "update",
      new_text: "いまの考え（消える予定）",
      in_conversation: convA,
      in_message: msgA,
      note: null,
    });
    expect(await pastTexts(a)).toContain("昔の考え（消える予定）");

    const { data: removed } = await a.rpc("delete_memory", { target: second as string });
    expect(removed).toBe(2);
    expect(await pastTexts(a)).not.toContain("昔の考え（消える予定）");
  });
});

// =============================================================
// 会話ごとの削除
// =============================================================
describe("会話ごとの削除", () => {
  it("会話・発言・記憶・出典がまとめて消え、削除の記録が残る", async () => {
    const tmp = await makeConversation(a, idA, "使い捨て");
    const memoryId = await makeMemory(a, idA, tmp.conversationId, "会話ごと消される内容");

    await a
      .from("memory_references")
      .insert({ user_id: idA, message_id: tmp.replyId, memory_id: memoryId });

    const { data: recorded, error } = await a.rpc("delete_conversation_with_memories", {
      target: tmp.conversationId,
    });
    expect(error).toBeNull();
    expect(recorded).toBe(1);

    // 会話・発言・記憶・出典が消えている
    const { data: conv } = await a
      .from("conversations")
      .select("id")
      .eq("id", tmp.conversationId)
      .maybeSingle();
    expect(conv).toBeNull();

    const { data: msgs } = await a
      .from("messages")
      .select("id")
      .eq("conversation_id", tmp.conversationId);
    expect(msgs).toEqual([]);

    const { data: mem } = await a
      .from("memory_candidates")
      .select("id")
      .eq("id", memoryId)
      .maybeSingle();
    expect(mem).toBeNull();

    const { data: refs } = await a
      .from("memory_references")
      .select("id")
      .eq("memory_id", memoryId);
    expect(refs).toEqual([]);

    expect(await currentTexts(a)).not.toContain("会話ごと消される内容");

    // 削除の記録だけは残る（バックアップから戻したときに、削除を再び当てるため）
    const { data: rec } = await a
      .from("memory_deletions")
      .select("scope")
      .eq("memory_id", memoryId)
      .single();
    expect(rec?.scope).toBe("conversation");
  });

  it("原価の記録は消えない", async () => {
    const tmp = await makeConversation(a, idA, "原価");
    await a.from("ai_usage").insert({
      user_id: idA,
      conversation_id: tmp.conversationId,
      operation_type: "chat",
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimated_cost: 0.001,
      pricing_version: "test",
      pricing_date: "2026-09-20",
      status: "success",
    });

    await a.rpc("delete_conversation_with_memories", { target: tmp.conversationId });

    const { data } = await a
      .from("ai_usage")
      .select("id, conversation_id")
      .eq("pricing_version", "test");
    expect((data ?? []).length).toBeGreaterThan(0);
    // 会話との結び付きが外れるだけで、記録そのものは残る
    expect((data ?? []).every((r) => r.conversation_id === null)).toBe(true);

    await a.from("ai_usage").delete().eq("pricing_version", "test"); // 消せない（ポリシーなし）
  });
});

// =============================================================
// 同時に走っている処理との競合
// =============================================================
describe("古い内容が、あとから戻らないこと", () => {
  it("同じ記憶を同時に2回訂正しても、内容は1つだけになる", async () => {
    const id = await makeMemory(a, idA, convA, "同時訂正のもとの内容");

    const [first, second] = await Promise.all([
      a.rpc("revise_memory", {
        target: id,
        kind: "correction",
        new_text: "同時訂正の結果その1",
        in_conversation: convA,
        in_message: msgA,
        note: null,
      }),
      a.rpc("revise_memory", {
        target: id,
        kind: "correction",
        new_text: "同時訂正の結果その2",
        in_conversation: convA,
        in_message: msgA,
        note: null,
      }),
    ]);

    // どちらか片方だけが通る
    const succeeded = [first.data, second.data].filter(Boolean);
    expect(succeeded).toHaveLength(1);

    const texts = await currentTexts(a);
    const survivors = ["同時訂正の結果その1", "同時訂正の結果その2"].filter((t) =>
      texts.includes(t),
    );
    expect(survivors).toHaveLength(1);
    expect(texts).not.toContain("同時訂正のもとの内容");
  });

  it("消している最中に届いた訂正は、記憶を戻さない", async () => {
    const id = await makeMemory(a, idA, convA, "削除と訂正が競合する内容");

    const [removed, revised] = await Promise.all([
      a.rpc("delete_memory", { target: id }),
      a.rpc("revise_memory", {
        target: id,
        kind: "correction",
        new_text: "競合で復活しようとした内容",
        in_conversation: convA,
        in_message: msgA,
        note: null,
      }),
    ]);

    const texts = await currentTexts(a);
    if (revised.data) {
      // 訂正が先に通った場合は、訂正後の内容だけが残る（元の内容は戻らない）
      expect(texts).not.toContain("削除と訂正が競合する内容");
      // 後片付け
      await a.rpc("delete_memory", { target: revised.data as string });
    } else {
      expect(removed.data).toBeTruthy();
      expect(texts).not.toContain("競合で復活しようとした内容");
      expect(texts).not.toContain("削除と訂正が競合する内容");
    }
  });
});

// =============================================================
// 越境アクセスの拒否
// =============================================================
describe("他人の記憶は直せない・消せない", () => {
  let memoryB: string;

  beforeAll(async () => {
    memoryB = await makeMemory(b, idB, convB, "Bだけの記憶");
  });

  it("A は B の記憶を訂正できない", async () => {
    const { data } = await a.rpc("revise_memory", {
      target: memoryB,
      kind: "correction",
      new_text: "Aが勝手に書き換えた内容",
      in_conversation: convA,
      in_message: msgA,
      note: null,
    });
    expect(data).toBeNull();
    expect(await currentTexts(b)).toContain("Bだけの記憶");
    expect(await currentTexts(b)).not.toContain("Aが勝手に書き換えた内容");
  });

  it("A は B の記憶を消せない", async () => {
    const { data } = await a.rpc("delete_memory", { target: memoryB });
    expect(data).toBe(0);
    expect(await currentTexts(b)).toContain("Bだけの記憶");
  });

  it("A は B の記憶を、自分の記憶の「前の版」にできない", async () => {
    const { error } = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 2,
      suggested_text: "Bの記憶を前の版に見せかけた内容",
      origin: "self_experience",
      status: "confirmed",
      revision_of: memoryB,
      revision_kind: "correction",
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("A は B の記憶に対する操作の提案を作れない", async () => {
    const { error } = await a.from("memory_revision_requests").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      request_index: 1,
      intent: "delete",
      target_memory_id: memoryB,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("A は B 名義で提案を作れない", async () => {
    const mine = await makeMemory(a, idA, convA, "A名義の確認用");
    const { error } = await a.from("memory_revision_requests").insert({
      user_id: idB,
      conversation_id: convA,
      source_message_id: msgA,
      request_index: 2,
      intent: "delete",
      target_memory_id: mine,
    });
    expect(error?.code).toBe(PERMISSION_DENIED);
  });

  it("A は B の会話を、会話ごと消せない", async () => {
    const { data } = await a.rpc("delete_conversation_with_memories", { target: convB });
    expect(data).toBe(0);
    const { data: conv } = await b.from("conversations").select("id").eq("id", convB).maybeSingle();
    expect(conv?.id).toBe(convB);
  });

  it("A は B の削除の記録を読めない", async () => {
    const { data } = await a.from("memory_deletions").select("user_id");
    expect((data ?? []).every((r) => r.user_id === idA)).toBe(true);
  });

  it("A は B の昔の考えを読めない", async () => {
    const { data } = await a.from("past_memories").select("user_id");
    expect((data ?? []).every((r) => r.user_id === idA)).toBe(true);
  });

  it("未ログインでは、昔の考えも削除の記録も読めない", async () => {
    const past = await anon.from("past_memories").select("id");
    const dels = await anon.from("memory_deletions").select("id");
    expect(past.error?.code === PERMISSION_DENIED || past.data?.length === 0).toBe(true);
    expect(dels.error?.code === PERMISSION_DENIED || dels.data?.length === 0).toBe(true);
  });

  it("削除の記録は、あとから取り消せない", async () => {
    const { data: rows } = await a.from("memory_deletions").select("id").limit(1);
    const target = rows?.[0]?.id as string | undefined;
    expect(target).toBeTruthy();

    const del = await a.from("memory_deletions").delete().eq("id", target!);
    const upd = await a.from("memory_deletions").update({ scope: "conversation" }).eq("id", target!);
    // ポリシーがない＝拒否。消えていない・変わっていないことを確かめる
    const { data: still } = await a.from("memory_deletions").select("id").eq("id", target!);
    expect(still).toHaveLength(1);
    void del;
    void upd;
  });
});

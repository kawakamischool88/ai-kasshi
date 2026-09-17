/**
 * 「消した・直した内容が、別の道から戻ってこないか」のテスト（Phase 3D）。
 *
 * 記憶の検索だけを塞いでも足りない。
 *   ・会話の文脈（過去のやりとり）
 *   ・返事を作っている最中の変更
 *   ・出典の表示
 * という別の道からも戻ってこないことを確かめる。
 *
 * 実際の開発用 Supabase へ、アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  fetchCandidateMemories,
  keepStillUsable,
  memoriesUnchanged,
  snapshotOf,
  type Memory,
} from "@/lib/ai/memory-search";
import { SYSTEM_PROMPT } from "@/config/prompt";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

let a: SupabaseClient;
let idA: string;
const conversations: string[] = [];

async function signIn(email: string, password: string) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { client, userId: data.user!.id };
}

async function newConversation(title: string): Promise<string> {
  const { data, error } = await a
    .from("conversations")
    .insert({ user_id: idA, title })
    .select("id")
    .single();
  if (error) throw new Error(`会話: ${error.message}`);
  conversations.push(data.id as string);
  return data.id as string;
}

async function say(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
): Promise<string> {
  const { data, error } = await a
    .from("messages")
    .insert({ conversation_id: conversationId, user_id: idA, role, content })
    .select("id")
    .single();
  if (error) throw new Error(`発言: ${error.message}`);
  return data.id as string;
}

async function makeMemory(
  conversationId: string,
  sourceMessageId: string,
  text: string,
  confirmedAt = new Date().toISOString(),
): Promise<string> {
  const { data, error } = await a
    .from("memory_candidates")
    .insert({
      user_id: idA,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      candidate_index: 1,
      suggested_text: text,
      origin: "self_experience",
      status: "confirmed",
      confirmed_at: confirmedAt,
    })
    .select("id")
    .single();
  if (error) throw new Error(`記憶「${text}」: ${error.message}`);
  return data.id as string;
}

/** アプリが返事を作るときに読む「AIへ送るやりとり」 */
async function aiContext(conversationId: string): Promise<string[]> {
  const { data } = await a
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .is("excluded_from_ai_at", null)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => m.content as string);
}

/** 画面に出る全部のやりとり */
async function screenContext(conversationId: string): Promise<string[]> {
  const { data } = await a
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => m.content as string);
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  if (!url || !anonKey || !pa) throw new Error(".env.test.local の設定が足りません");
  ({ client: a, userId: idA } = await signIn("kasshi-test-a@example.com", pa));
});

afterAll(async () => {
  for (const id of conversations) await a.from("conversations").delete().eq("id", id);
});

// =============================================================
// ① 会話の文脈から、古い内容が戻ってこないこと
// =============================================================
describe("訂正したあと、会話に残る古い内容をAIへ送らない", () => {
  let conv: string;
  let memoryId: string;

  beforeAll(async () => {
    conv = await newConversation("締め日の話（文脈テスト）");
    const q = await say(conv, "user", "仕入先の締め日は毎月20日です。");
    await say(conv, "assistant", "20日なんですね。覚えておきます。");
    memoryId = await makeMemory(conv, q, "仕入先の締め日は毎月20日");

    const correction = await say(conv, "user", "違う、25日だったよ。");
    const { data } = await a.rpc("revise_memory", {
      target: memoryId,
      kind: "correction",
      new_text: "仕入先の締め日は毎月25日",
      in_conversation: conv,
      in_message: correction,
      note: "本人が訂正",
    });
    expect(data).toBeTruthy();
  });

  it("AIへ送るやりとりから、古い「20日」が消えている", async () => {
    const context = await aiContext(conv);
    expect(context.some((c) => c.includes("毎月20日です"))).toBe(false);
    expect(context.some((c) => c.includes("20日なんですね"))).toBe(false);
  });

  it("本人が言い直した発言は、AIへ送られる", async () => {
    const context = await aiContext(conv);
    expect(context.some((c) => c.includes("25日だったよ"))).toBe(true);
  });

  it("画面の過去会話には、これまで通り残っている", async () => {
    const screen = await screenContext(conv);
    expect(screen.some((c) => c.includes("毎月20日です"))).toBe(true);
    expect(screen.some((c) => c.includes("20日なんですね"))).toBe(true);
  });

  it("なぜ送らないことにしたかが記録されている", async () => {
    const { data } = await a
      .from("messages")
      .select("exclusion_reason")
      .eq("conversation_id", conv)
      .not("excluded_from_ai_at", "is", null);
    expect((data ?? []).length).toBeGreaterThan(0);
    expect((data ?? []).every((m) => m.exclusion_reason === "corrected")).toBe(true);
  });
});

describe("削除したあと、会話に残る消した内容をAIへ送らない", () => {
  let conv: string;

  beforeAll(async () => {
    conv = await newConversation("健康の話（文脈テスト）");
    const q = await say(conv, "user", "昨年の健康診断で血圧が少し高めと言われました。");
    await say(conv, "assistant", "血圧が高めと言われたのですね。");
    const memoryId = await makeMemory(conv, q, "昨年の健康診断で、血圧が少し高めと言われた");

    const { data } = await a.rpc("delete_memory", { target: memoryId });
    expect(data).toBe(1);
  });

  it("AIへ送るやりとりから、消した内容が消えている", async () => {
    const context = await aiContext(conv);
    expect(context.some((c) => c.includes("血圧"))).toBe(false);
  });

  it("画面の過去会話には残っている（本人は読み返せる）", async () => {
    const screen = await screenContext(conv);
    expect(screen.some((c) => c.includes("血圧"))).toBe(true);
  });

  it("消した記憶は、検索にも出てこない", async () => {
    const found = await fetchCandidateMemories(a, idA, "血圧について教えて");
    expect(found.some((m) => m.text.includes("血圧"))).toBe(false);
  });
});

describe("考えが変わったあとも、古い言い方をAIへ送らない", () => {
  it("古い考えを語ったやりとりは、AIへ送られなくなる", async () => {
    const conv = await newConversation("考えの変化（文脈テスト）");
    const q = await say(conv, "user", "新商品は小さく試すのを大切にしています。");
    await say(conv, "assistant", "小さく試すのを大切にされているんですね。");
    const memoryId = await makeMemory(conv, q, "新商品は小さく試すのを大切にしている");

    const said = await say(conv, "user", "最近は考えが変わりました。");
    await a.rpc("revise_memory", {
      target: memoryId,
      kind: "update",
      new_text: "ブランド設計を最初に決めた方がよいと思っている",
      in_conversation: conv,
      in_message: said,
      note: null,
    });

    const context = await aiContext(conv);
    expect(context.some((c) => c.includes("小さく試すのを大切にしています"))).toBe(false);
    expect(context.some((c) => c.includes("小さく試すのを大切にされている"))).toBe(false);
    expect(context.some((c) => c.includes("考えが変わりました"))).toBe(true);
  });
});

// =============================================================
// ② 返事を作っている最中の変更
// =============================================================
describe("返事を作っている最中に記憶が変わったら、その返事は使わない", () => {
  let conv: string;
  let memoryId: string;
  let memory: Memory;

  beforeAll(async () => {
    conv = await newConversation("生成中の変更テスト");
    const q = await say(conv, "user", "浅虫温泉の宿の話。");
    memoryId = await makeMemory(conv, q, "浅虫温泉の宿は、朝食が早い時間から出る");
    const found = await fetchCandidateMemories(a, idA, "浅虫温泉の宿について");
    memory = found.find((m) => m.id === memoryId)!;
    expect(memory).toBeTruthy();
  });

  it("何も変わっていなければ、返事を保存してよい", async () => {
    const ok = await memoriesUnchanged(
      a,
      idA,
      snapshotOf([memory]),
      new Map([[memory.id, false]]),
    );
    expect(ok).toBe(true);
  });

  it("送ったあとに訂正されたら、返事を保存しない", async () => {
    const said = await say(conv, "user", "違う、朝食は遅めでした。");
    const { data } = await a.rpc("revise_memory", {
      target: memoryId,
      kind: "correction",
      new_text: "浅虫温泉の宿は、朝食が遅めの時間から出る",
      in_conversation: conv,
      in_message: said,
      note: null,
    });
    expect(data).toBeTruthy();

    const ok = await memoriesUnchanged(
      a,
      idA,
      snapshotOf([memory]),
      new Map([[memory.id, false]]),
    );
    expect(ok).toBe(false);
  });

  it("送ったあとに削除されたら、返事を保存しない", async () => {
    const conv2 = await newConversation("生成中の削除テスト");
    const q = await say(conv2, "user", "八甲田の山小屋の話。");
    const id = await makeMemory(conv2, q, "八甲田の山小屋は、冬は閉まっている");
    const found = await fetchCandidateMemories(a, idA, "八甲田の山小屋について");
    const m = found.find((x) => x.id === id)!;

    await a.rpc("delete_memory", { target: id });

    const ok = await memoriesUnchanged(a, idA, snapshotOf([m]), new Map([[m.id, false]]));
    expect(ok).toBe(false);
  });

  it("渡す直前の確認でも、版が変わった記憶は外れる", async () => {
    const conv3 = await newConversation("渡す直前の確認テスト");
    const q = await say(conv3, "user", "奥入瀬の売店の話。");
    const id = await makeMemory(conv3, q, "奥入瀬の売店は、平日は昼で閉まる");
    const found = await fetchCandidateMemories(a, idA, "奥入瀬の売店について");
    const m = found.find((x) => x.id === id)!;

    const said = await say(conv3, "user", "違う、夕方まで開いていました。");
    await a.rpc("revise_memory", {
      target: id,
      kind: "correction",
      new_text: "奥入瀬の売店は、平日も夕方まで開いている",
      in_conversation: conv3,
      in_message: said,
      note: null,
    });

    const kept = await keepStillUsable(a, idA, [m]);
    expect(kept).toEqual([]);
  });

  it("記憶を渡していない返事は、いつでも保存してよい", async () => {
    const ok = await memoriesUnchanged(a, idA, [], new Map());
    expect(ok).toBe(true);
  });
});

// =============================================================
// ③ 会話を消したあとの出典（墓標）
// =============================================================
describe("会話を消しても、別の会話の出典に「参考にした事実」だけ残る", () => {
  it("本文は残らず、削除された事実と日時だけ残る", async () => {
    // 記憶のもとになる会話
    const source = await newConversation("記憶のもと（墓標テスト）");
    const q = await say(source, "user", "十和田の工房の話。");
    const memoryId = await makeMemory(source, q, "十和田の工房は、月曜が定休日");

    // 別の会話で、その記憶を使った返事
    const other = await newConversation("別の会話（墓標テスト）");
    await say(other, "user", "工房はいつ開いていますか。");
    const reply = await say(other, "assistant", "以前、月曜が定休日とうかがっていました。");
    const { error } = await a
      .from("memory_references")
      .insert({ user_id: idA, message_id: reply, memory_id: memoryId });
    expect(error).toBeNull();

    // もとの会話ごと消す
    await a.rpc("delete_conversation_with_memories", { target: source });

    // 出典の行は残っている
    const { data: refs } = await a
      .from("memory_references")
      .select("memory_id, memory_deleted_at")
      .eq("message_id", reply);

    expect(refs).toHaveLength(1);
    expect(refs![0].memory_id).toBeNull(); // 中身へのつながりは切れている
    expect(refs![0].memory_deleted_at).toBeTruthy(); // 消えた日時は残っている

    // 本文はどこにも残っていない
    const { data: mem } = await a
      .from("memory_candidates")
      .select("id")
      .eq("id", memoryId)
      .maybeSingle();
    expect(mem).toBeNull();

    // 出典の行に、本文らしい列がない
    expect(Object.keys(refs![0])).not.toContain("text");
  });

  it("出典は、あとから書き換えも取り消しもできない", async () => {
    const { data: rows } = await a.from("memory_references").select("id").limit(1);
    const target = rows?.[0]?.id as string | undefined;
    expect(target).toBeTruthy();

    await a.from("memory_references").update({ memory_deleted_at: null }).eq("id", target!);
    await a.from("memory_references").delete().eq("id", target!);

    // ポリシーがない＝拒否。消えていない・変わっていないことを確かめる
    const { data: still } = await a
      .from("memory_references")
      .select("id")
      .eq("id", target!);
    expect(still).toHaveLength(1);
  });

  it("削除の記録も、あとから書き換えも取り消しもできない", async () => {
    const { data: rows } = await a.from("memory_deletions").select("id, scope").limit(1);
    const target = rows?.[0];
    expect(target).toBeTruthy();

    await a.from("memory_deletions").update({ scope: "memory_only" }).eq("id", target!.id);
    await a.from("memory_deletions").delete().eq("id", target!.id);

    const { data: still } = await a
      .from("memory_deletions")
      .select("id, scope")
      .eq("id", target!.id);
    expect(still).toHaveLength(1);
    expect(still![0].scope).toBe(target!.scope);
  });
});

// =============================================================
// ④ 記憶が多くても、古いものが検索から外れないこと
// =============================================================
describe("記憶が200件を超えても、古いものを検索できる", () => {
  let conv: string;
  const TOTAL = 205;

  beforeAll(async () => {
    conv = await newConversation("たくさんの記憶（検索テスト）");

    // いちばん古い記憶に、他と重ならない名前を入れておく
    const base = Date.parse("2026-01-01T00:00:00Z");
    const messages = Array.from({ length: TOTAL }, (_, i) => ({
      conversation_id: conv,
      user_id: idA,
      role: "user" as const,
      content: `まとめて作る発言${i}`,
    }));
    const { data: msgs, error: e1 } = await a.from("messages").insert(messages).select("id");
    if (e1) throw new Error(`まとめて作る発言: ${e1.message}`);

    const rows = msgs!.map((m, i) => ({
      user_id: idA,
      conversation_id: conv,
      source_message_id: m.id,
      candidate_index: 1,
      suggested_text:
        i === 0
          ? "ヒバ材の卸は、六戸の丸善木材さんにお願いしている"
          : `番号${i}の記録。日々の細かい覚え書きです。`,
      origin: "self_experience",
      status: "confirmed",
      // i=0 がいちばん古くなるように（新しい順に並べると最後になる）
      confirmed_at: new Date(base + i * 60_000).toISOString(),
    }));
    const { error: e2 } = await a.from("memory_candidates").insert(rows);
    if (e2) throw new Error(`まとめて作る記憶: ${e2.message}`);
  });

  it("205件すべてが確定記憶として入っている", async () => {
    const { count } = await a
      .from("confirmed_memories")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conv);
    expect(count).toBe(TOTAL);
  });

  it("いちばん古い記憶も、検索の対象に入る（201件目以降で切り捨てない）", async () => {
    const found = await fetchCandidateMemories(a, idA, "丸善木材さんへのヒバ材の注文について");
    expect(found.some((m) => m.text.includes("丸善木材"))).toBe(true);
  });

  it("古い固有名詞でも見つかる", async () => {
    const found = await fetchCandidateMemories(a, idA, "六戸の取引先はどこだったかな");
    expect(found.some((m) => m.text.includes("六戸"))).toBe(true);
  });

  it("AIに見せる件数は、これまで通り40件までに絞られる", async () => {
    const found = await fetchCandidateMemories(a, idA, "番号について");
    expect(found.length).toBeLessThanOrEqual(40);
  });
});

// =============================================================
// ⑤ 期限切れの候補が、いまどうなっているか（調査）
// =============================================================
describe("期限切れの候補の、いまの保持状態", () => {
  it("30日をすぎると「期限切れ」の印が付く。本文はDBに残る", async () => {
    const conv = await newConversation("期限切れの調査");
    const q = await say(conv, "user", "期限切れの調査用の発言。");
    const past = new Date(Date.now() - 1000).toISOString();

    const { data: created } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: conv,
        source_message_id: q,
        candidate_index: 1,
        suggested_text: "期限切れになる予定の候補",
        origin: "self_experience",
        status: "pending",
        expires_at: past,
      })
      .select("id")
      .single();

    // 画面を開いたときに行われるのと同じ処理
    await a
      .from("memory_candidates")
      .update({ status: "expired" })
      .eq("status", "pending")
      .lte("expires_at", new Date().toISOString());

    const { data: row } = await a
      .from("memory_candidates")
      .select("status, suggested_text, confirmed_text, expires_at")
      .eq("id", created!.id)
      .single();

    // いまの動き：印は付くが、本文はそのまま残っている
    expect(row?.status).toBe("expired");
    expect(row?.suggested_text).toBe("期限切れになる予定の候補");
    expect(row?.confirmed_text).toBeNull();
  });

  it("期限切れの候補は、確定記憶にも昔の考えにも出てこない", async () => {
    const current = await a.from("confirmed_memories").select("text");
    const past = await a.from("past_memories").select("text");
    const all = [...(current.data ?? []), ...(past.data ?? [])].map((r) => r.text as string);
    expect(all).not.toContain("期限切れになる予定の候補");
  });

  it("期限切れの候補は、検索にも出てこない", async () => {
    const found = await fetchCandidateMemories(a, idA, "期限切れになる予定の候補");
    expect(found.some((m) => m.text.includes("期限切れになる予定"))).toBe(false);
  });
});

// =============================================================
// ⑥ 本人が編集して確定したときの、由来の追跡
// =============================================================
describe("本人が文章を直して確定したときの由来", () => {
  it("元発言・AIの案・本人の最終文・確定日時を、別々にたどれる", async () => {
    const conv = await newConversation("編集の由来テスト");
    const utterance = "青森ひばの仕入れは、春に多めに頼むようにしています。";
    const q = await say(conv, "user", utterance);

    const aiDraft = "青森ひばの仕入れは春に多めに頼んでいる";
    const { data: created } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: conv,
        source_message_id: q,
        candidate_index: 1,
        suggested_text: aiDraft,
        origin: "self_experience",
        status: "pending",
      })
      .select("id")
      .single();

    // 本人が大きく書き直して確定する
    const edited = "青森ひばは、値上がりする前の春のうちに、年間ぶんをまとめて仕入れる";
    const { data: confirmed } = await a
      .from("memory_candidates")
      .update({
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        confirmed_text: edited,
      })
      .eq("id", created!.id)
      .eq("status", "pending")
      .select("source_message_id, suggested_text, confirmed_text, confirmed_at, origin")
      .single();

    // ① 元発言
    expect(confirmed?.source_message_id).toBe(q);
    const { data: src } = await a.from("messages").select("content").eq("id", q).single();
    expect(src?.content).toBe(utterance);

    // ② AIの案（本人の編集に上書きされていない）
    expect(confirmed?.suggested_text).toBe(aiDraft);

    // ③ 本人が編集した最終文
    expect(confirmed?.confirmed_text).toBe(edited);
    expect(confirmed?.confirmed_text).not.toBe(confirmed?.suggested_text);

    // ④ 本人が確定した日時
    expect(confirmed?.confirmed_at).toBeTruthy();

    // 検索・回答に使われるのは、本人の最終文のほう
    const found = await fetchCandidateMemories(a, idA, "青森ひばの仕入れ時期");
    const m = found.find((x) => x.text.includes("青森ひば"));
    expect(m?.text).toBe(edited);
  });
});

// =============================================================
// ⑦ 見つからないときの言い方
// =============================================================
describe("記録が見つからないときに、断定しないこと", () => {
  it("基本指示に、断定しない言い方が書かれている", () => {
    expect(SYSTEM_PROMPT).toContain("関係する記録が見つからなかった");
    expect(SYSTEM_PROMPT).toContain("相手は話したのに、こちらが見つけられていないだけかもしれません");
  });

  it("使ってはいけない言い方が、はっきり書かれている", () => {
    expect(SYSTEM_PROMPT).toContain("×「話したことがないですね」");
    expect(SYSTEM_PROMPT).toContain("×「そんな事実はありません」");
  });
});

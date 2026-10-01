/**
 * 削除の考え方の統一（Phase A ／ G1・G3・R1・N-1・さかのぼり）のテスト。
 *
 * 架空ユーザー A・B で、開発用 Supabase に接続して確かめる。
 * アプリと同じ公開用キーで接続する。
 * さかのぼりの関数だけは画面から呼べない作りなので、運営用のキー（service_role）で呼ぶ
 * （service_role を使うのは scripts/ と tests/ だけ）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let a: SupabaseClient;
let b: SupabaseClient;
let admin: SupabaseClient;
let idA: string;
let idB: string;
const created: string[] = []; // A が作った会話（最後に片付ける）
let bCountsBefore: Record<string, number>;

const TAG = `phaseA-${Math.random().toString(36).slice(2, 8)}`;

function client(key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string) {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { c, id: data.user!.id };
}

async function conv(label: string): Promise<string> {
  const { data, error } = await a
    .from("conversations")
    .insert({ user_id: idA, title: `${TAG} ${label}` })
    .select("id")
    .single();
  if (error) throw new Error(`会話: ${error.message}`);
  created.push(data.id as string);
  return data.id as string;
}

async function say(conversationId: string, role: "user" | "assistant", content: string): Promise<string> {
  const { data, error } = await a
    .from("messages")
    .insert({ conversation_id: conversationId, user_id: idA, role, content })
    .select("id")
    .single();
  if (error) throw new Error(`発言: ${error.message}`);
  return data.id as string;
}

async function memory(conversationId: string, sourceMessageId: string, text: string): Promise<string> {
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
      confirmed_at: new Date().toISOString(),
      extraction_reason: `理由 ${text}`,
    })
    .select("id")
    .single();
  if (error) throw new Error(`記憶: ${error.message}`);
  return data.id as string;
}

async function use(messageId: string, memoryId: string) {
  const { error } = await a.from("memory_references").insert({ user_id: idA, message_id: messageId, memory_id: memoryId });
  if (error) throw new Error(`出典: ${error.message}`);
}

async function request(
  conversationId: string,
  sourceMessageId: string,
  target: string,
  intent: "correct" | "update" | "delete",
  index = 1,
): Promise<string> {
  const { data, error } = await a
    .from("memory_revision_requests")
    .insert({
      user_id: idA,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      request_index: index,
      intent,
      target_memory_id: target,
      proposed_text: intent === "delete" ? null : `${TAG} 文章の案`,
      reason: `${TAG} AIの理由`,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(`提案: ${error.message}`);
  return data.id as string;
}

/** アプリが返事を作るときに読む「AIへ送るやりとり」（actions.ts の runTurn と同じ条件） */
async function aiContext(conversationId: string): Promise<string[]> {
  const { data } = await a
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .is("excluded_from_ai_at", null)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => m.content as string);
}

/** 画面に出るやりとり（すべて） */
async function screen(conversationId: string): Promise<string[]> {
  const { data } = await a
    .from("messages")
    .select("content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => m.content as string);
}

async function msg(id: string) {
  const { data } = await a
    .from("messages")
    .select("content, excluded_from_ai_at, exclusion_reason")
    .eq("id", id)
    .maybeSingle();
  return data;
}

async function mem(id: string) {
  const { data } = await a
    .from("memory_candidates")
    .select("status, suggested_text, confirmed_text, extraction_reason, deleted_at")
    .eq("id", id)
    .maybeSingle();
  return data;
}

async function req(id: string) {
  const { data } = await a
    .from("memory_revision_requests")
    .select("status, proposed_text, reason, resolved_at, intent, target_memory_id")
    .eq("id", id)
    .maybeSingle();
  return data;
}

/** いまの記憶・以前の考えの本文（AIへ渡りうるもの）に、目印が無いこと */
async function noTextAnywhere(marker: string) {
  const { data: current } = await a.from("confirmed_memories").select("text");
  const { data: past } = await a.from("past_memories").select("text");
  const texts = [...(current ?? []), ...(past ?? [])].map((r) => String(r.text));
  expect(texts.some((t) => t.includes(marker))).toBe(false);
}

/** B の行の件数（A の操作で B が変わらないことを確かめる） */
async function countsOf(c: SupabaseClient, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [
    "conversations",
    "messages",
    "memory_candidates",
    "memory_references",
    "memory_revision_requests",
    "memory_deletions",
    "conversation_deletions",
  ]) {
    const { count } = await c.from(t).select("*", { count: "exact", head: true }).eq("user_id", userId);
    out[t] = count ?? -1;
  }
  // B の記憶の本文と印の状態も控える
  const { data: m } = await c.from("memory_candidates").select("id, status, suggested_text").eq("user_id", userId);
  out["memory_state"] = JSON.stringify((m ?? []).sort((x, y) => String(x.id).localeCompare(String(y.id)))).length;
  const { count: ex } = await c
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("excluded_from_ai_at", "is", null);
  out["excluded"] = ex ?? -1;
  return out;
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !serviceKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");
  ({ c: a, id: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ c: b, id: idB } = await signIn("kasshi-test-b@example.com", pb));
  admin = client(serviceKey);
  bCountsBefore = await countsOf(b, idB);
});

afterAll(async () => {
  // 残った会話を消し、このテストで増えた記録（本文なし）を片付ける
  for (const c of created) await admin.from("conversations").delete().eq("id", c);
  await admin.from("conversation_deletions").delete().in("conversation_id", created);
  await admin.from("memory_deletions").delete().in("conversation_id", created);
});

// =============================================================
// G1：会話ごと消すと、その会話の記憶を使った別の会話の返事は AI へ送らない
// =============================================================
describe("G1 会話ごと消す：別の会話の返事は読めるが、AIへ送らない", () => {
  let A: string, B: string, C: string;
  let M: string, N: string;
  let replyUsingM: string, replyNotUsing: string, replyUsingN: string, bUser: string;

  beforeAll(async () => {
    // 会話Aで記憶Mを残す
    A = await conv("会話A");
    const qa = await say(A, "user", `${TAG} 工房は月曜が定休日`);
    await say(A, "assistant", "月曜が定休日なのですね");
    M = await memory(A, qa, `${TAG}-M 工房は月曜が定休日`);

    // 関係のない記憶N（会話C）
    C = await conv("会話C");
    const qc = await say(C, "user", `${TAG} 納品は木曜`);
    N = await memory(C, qc, `${TAG}-N 納品は木曜`);

    // 会話Bで、Mを使った返事・使っていない返事・Nを使った返事
    B = await conv("会話B");
    bUser = await say(B, "user", `${TAG} 工房はいつ開いていますか`);
    replyUsingM = await say(B, "assistant", `${TAG} 以前、月曜が定休日とうかがっていました`);
    await use(replyUsingM, M);
    await say(B, "user", `${TAG} ありがとう`);
    replyNotUsing = await say(B, "assistant", `${TAG} どういたしまして`);
    await say(B, "user", `${TAG} 納品は？`);
    replyUsingN = await say(B, "assistant", `${TAG} 木曜とうかがっています`);
    await use(replyUsingN, N);

    // 消す前は、Mを使った返事もAIへ送られる
    expect(await aiContext(B)).toContain(`${TAG} 以前、月曜が定休日とうかがっていました`);

    const { data: n, error } = await a.rpc("delete_conversation_with_memories", { target: A });
    expect(error).toBeNull();
    expect(n).toBe(1);
  });

  it("会話Aは消え、会話の削除の記録（本文なし）が残る", async () => {
    const { data: gone } = await a.from("conversations").select("id").eq("id", A).maybeSingle();
    expect(gone).toBeNull();
    const { data: rec } = await a
      .from("conversation_deletions")
      .select("*")
      .eq("conversation_id", A)
      .single();
    expect(rec?.user_id).toBe(idA);
    // 本文・見出しを持つ列が無い
    expect(Object.keys(rec!).sort()).toEqual(["conversation_id", "deleted_at", "id", "user_id"]);
  });

  it("会話BのMを使った返事は、本文が残り画面で読める", async () => {
    const r = await msg(replyUsingM);
    expect(r?.content).toBe(`${TAG} 以前、月曜が定休日とうかがっていました`);
    expect(await screen(B)).toContain(`${TAG} 以前、月曜が定休日とうかがっていました`);
  });

  it("その返事には「AIへ送らない印」が付き、次に返事を作るときの材料から外れる", async () => {
    const r = await msg(replyUsingM);
    expect(r?.excluded_from_ai_at).toBeTruthy();
    expect(r?.exclusion_reason).toBe("deleted");
    expect(await aiContext(B)).not.toContain(`${TAG} 以前、月曜が定休日とうかがっていました`);
  });

  it("Mを使っていない返事・本人の発言・関係のない記憶Nを使った返事は巻き込まない", async () => {
    const ctx = await aiContext(B);
    expect(ctx).toContain(`${TAG} どういたしまして`);
    expect(ctx).toContain(`${TAG} 工房はいつ開いていますか`);
    expect(ctx).toContain(`${TAG} 木曜とうかがっています`);
    expect((await msg(replyNotUsing))?.excluded_from_ai_at).toBeNull();
    expect((await msg(replyUsingN))?.excluded_from_ai_at).toBeNull();
    expect((await msg(bUser))?.excluded_from_ai_at).toBeNull();

    const n = await mem(N);
    expect(n?.status).toBe("confirmed");
    expect(n?.suggested_text).toBe(`${TAG}-N 納品は木曜`);
  });

  it("記憶Mの本文はどこにも残らず、削除の記録（本文なし）が残る", async () => {
    expect(await mem(M)).toBeNull(); // 会話Aと一緒に消えた
    await noTextAnywhere(`${TAG}-M`);
    const { data: d } = await a.from("memory_deletions").select("scope").eq("memory_id", M).single();
    expect(d?.scope).toBe("conversation");
    // 出典は墓標（番号が外れ、消えた日時だけ）
    const { data: ref } = await a
      .from("memory_references")
      .select("memory_id, memory_deleted_at")
      .eq("message_id", replyUsingM)
      .single();
    expect(ref?.memory_id).toBeNull();
    expect(ref?.memory_deleted_at).toBeTruthy();
  });
});

// =============================================================
// N-1：会話をまたいで訂正・考えの変化をした記憶は、系列ごと消す
// =============================================================
describe("N-1 会話をまたいだ系列も、系列ごと本文なしの削除になる", () => {
  it("会話Aの記憶を会話Bで訂正 → 会話Aを消す：Bの新しい版も消え、Bの返事はAIへ送らない", async () => {
    const A = await conv("N1-元の会話");
    const qa = await say(A, "user", `${TAG} 締め日は20日`);
    const M1 = await memory(A, qa, `${TAG}-N1a 締め日は20日`);

    const B = await conv("N1-訂正した会話");
    const qb = await say(B, "user", `${TAG} 締め日は25日の間違いでした`);
    const { data: M2, error: e1 } = await a.rpc("revise_memory", {
      target: M1,
      kind: "correction",
      new_text: `${TAG}-N1a 締め日は25日`,
      in_conversation: B,
      in_message: qb,
    });
    expect(e1).toBeNull();
    const replyB = await say(B, "assistant", `${TAG} 25日ですね`);
    await use(replyB, M2 as string);

    // 別の会話Dでも M2 を使い、M2 への訂正の提案（確認待ち）がある
    const D = await conv("N1-別の会話");
    const qd = await say(D, "user", `${TAG} 締め日は？`);
    const replyD = await say(D, "assistant", `${TAG} 25日とうかがっています`);
    await use(replyD, M2 as string);
    const reqD = await request(D, qd, M2 as string, "correct");

    // 以前はここで、DB の決まりに引っかかって削除そのものが失敗していた
    const { error } = await a.rpc("delete_conversation_with_memories", { target: A });
    expect(error).toBeNull();

    // 新しい版 M2（会話Bにある）も、本文なしの削除
    const m2 = await mem(M2 as string);
    expect(m2?.status).toBe("deleted");
    expect(m2?.suggested_text).toBeNull();
    expect(m2?.confirmed_text).toBeNull();
    expect(m2?.extraction_reason).toBeNull();
    await noTextAnywhere(`${TAG}-N1a`);

    // 削除の記録は系列の両方に残る
    const { data: recs } = await a.from("memory_deletions").select("memory_id").in("memory_id", [M1, M2]);
    expect((recs ?? []).length).toBe(2);

    // 会話B・Dは残り、読めるが、系列を使った返事と訂正の発言は AI へ送らない
    expect(await screen(B)).toContain(`${TAG} 25日ですね`);
    expect(await aiContext(B)).not.toContain(`${TAG} 25日ですね`);
    expect(await aiContext(B)).not.toContain(`${TAG} 締め日は25日の間違いでした`);
    expect(await screen(D)).toContain(`${TAG} 25日とうかがっています`);
    expect(await aiContext(D)).not.toContain(`${TAG} 25日とうかがっています`);
    expect(await aiContext(D)).toContain(`${TAG} 締め日は？`);

    // 会話Dの提案は、文章の案と理由が消え、閉じている
    const r = await req(reqD);
    expect(r?.proposed_text).toBeNull();
    expect(r?.reason).toBeNull();
    expect(r?.status).toBe("dismissed");
    expect(r?.resolved_at).toBeTruthy();
    expect(r?.intent).toBe("correct"); // 本文ではない情報は残る
  });

  it("会話Bの記憶を会話Aで考えの変化 → 会話Aを消す：Bの以前の考えも残らない", async () => {
    const B = await conv("N1-元の会話2");
    const qb = await say(B, "user", `${TAG} 新商品は大きく出す`);
    const M1 = await memory(B, qb, `${TAG}-N1b 新商品は大きく出す`);

    const A = await conv("N1-考えが変わった会話");
    const qa = await say(A, "user", `${TAG} やっぱり小さく試す`);
    const { error: e1 } = await a.rpc("revise_memory", {
      target: M1,
      kind: "update",
      new_text: `${TAG}-N1b 新商品は小さく試す`,
      in_conversation: A,
      in_message: qa,
    });
    expect(e1).toBeNull();
    expect((await mem(M1))?.status).toBe("archived");

    const { error } = await a.rpc("delete_conversation_with_memories", { target: A });
    expect(error).toBeNull();

    // 会話Bに残る「以前の考え」も、本文なしの削除（片方だけ残らない）
    const m1 = await mem(M1);
    expect(m1?.status).toBe("deleted");
    expect(m1?.suggested_text).toBeNull();
    await noTextAnywhere(`${TAG}-N1b`);

    // 会話Bの本人の発言は、画面には残る（AIへは送らない）
    expect(await screen(B)).toContain(`${TAG} 新商品は大きく出す`);
    expect(await aiContext(B)).not.toContain(`${TAG} 新商品は大きく出す`);
  });
});

// =============================================================
// G3：記憶だけ消しても、提案の文章の案と理由は残らない
// =============================================================
describe("G3 記憶を消すと、提案の文章の案と理由を消し、確認待ちなら閉じる", () => {
  it("確認待ちの提案・閉じた提案のどちらも、本文なし", async () => {
    const E = await conv("G3");
    const q = await say(E, "user", `${TAG} 仕入れ先は山田商店`);
    const M = await memory(E, q, `${TAG}-G3 仕入れ先は山田商店`);
    const q2 = await say(E, "user", `${TAG} それ違う`);
    const pending = await request(E, q2, M, "correct", 1);
    const closed = await request(E, q2, M, "update", 2);
    await a.from("memory_revision_requests").update({ status: "dismissed", resolved_at: "2026-09-01T00:00:00Z" }).eq("id", closed);

    const { data: n, error } = await a.rpc("delete_memory", { target: M });
    expect(error).toBeNull();
    expect(n).toBe(1);

    const p = await req(pending);
    expect(p?.proposed_text).toBeNull();
    expect(p?.reason).toBeNull();
    expect(p?.status).toBe("dismissed");
    expect(p?.resolved_at).toBeTruthy();
    expect(p?.target_memory_id).toBe(M);

    const c = await req(closed);
    expect(c?.proposed_text).toBeNull();
    expect(c?.reason).toBeNull();
    expect(c?.status).toBe("dismissed");
    expect(c?.resolved_at).toBe("2026-09-01T00:00:00+00:00"); // 閉じた日時は書き換えない

    const m = await mem(M);
    expect(m?.status).toBe("deleted");
    expect(m?.extraction_reason).toBeNull();
    // 元の会話は残る（記憶だけ消す）
    expect(await screen(E)).toContain(`${TAG} 仕入れ先は山田商店`);
  });

  it("関係のない記憶への提案は変わらない", async () => {
    const E = await conv("G3-関係なし");
    const q = await say(E, "user", `${TAG} 定休日は日曜`);
    const keep = await memory(E, q, `${TAG}-G3keep 定休日は日曜`);
    const drop = await memory(E, await say(E, "user", `${TAG} 別の話`), `${TAG}-G3drop 別の話`);
    const r = await request(E, q, keep, "correct");

    await a.rpc("delete_memory", { target: drop });

    const after = await req(r);
    expect(after?.proposed_text).toBe(`${TAG} 文章の案`);
    expect(after?.reason).toBe(`${TAG} AIの理由`);
    expect(after?.status).toBe("pending");
  });
});

// =============================================================
// さかのぼり（A4）：この migration より前に消した分
// =============================================================
describe("A4 さかのぼり：以前に消した分を、何度実行しても安全にそろえる", () => {
  it("墓標の出典が付いた返事・片方だけ残った版・消えた記憶への提案を直す。2回目は何もしない", async () => {
    /* 以前の作りで会話ごと消した後の状態を、運営用のキーで直接作る */
    const F = await conv("A4");
    const reply = await say(F, "assistant", `${TAG} 以前の作りで消した記憶を使った返事`);
    const { error: e1 } = await admin
      .from("memory_references")
      .insert({ user_id: idA, message_id: reply, memory_id: null, memory_deleted_at: "2026-09-20T00:00:00Z" });
    expect(e1).toBeNull();

    // 片方だけ残った「以前の考え」（新しい版の会話が消えた）
    const src = await say(F, "user", `${TAG} 昔の考えの元の発言`);
    const after = await say(F, "assistant", `${TAG} 昔の考えの直後の返事`);
    const orphan = await memory(F, src, `${TAG}-A4orphan 昔の考え`);
    const { error: e2 } = await admin.from("memory_candidates").update({ status: "archived" }).eq("id", orphan);
    expect(e2).toBeNull();

    // 消えた記憶に、本文付きの提案が残っている
    const src2 = await say(F, "user", `${TAG} 消した記憶の元の発言`);
    const gone = await memory(F, src2, `${TAG}-A4gone 消した記憶`);
    const r = await request(F, src2, gone, "correct");
    const { error: e3 } = await admin
      .from("memory_candidates")
      .update({ status: "deleted", suggested_text: null, confirmed_text: null, extraction_reason: null })
      .eq("id", gone);
    expect(e3).toBeNull();

    // 画面からは呼べない
    const { error: denied } = await a.rpc("repair_deletion_leftovers");
    expect(denied).not.toBeNull();

    const { data: first, error } = await admin.rpc("repair_deletion_leftovers");
    expect(error).toBeNull();
    expect(first.messages_excluded).toBeGreaterThanOrEqual(3);
    expect(first.orphan_versions_deleted).toBeGreaterThanOrEqual(1);
    expect(first.requests_scrubbed).toBeGreaterThanOrEqual(1);

    // 墓標の出典が付いた返事：本文は残り、AIへ送らない
    const rm = await msg(reply);
    expect(rm?.content).toBe(`${TAG} 以前の作りで消した記憶を使った返事`);
    expect(rm?.excluded_from_ai_at).toBeTruthy();

    // 片方だけ残った版：本文なしの削除・記録あり・元の発言と直後の返事に印
    const o = await mem(orphan);
    expect(o?.status).toBe("deleted");
    expect(o?.suggested_text).toBeNull();
    expect((await msg(src))?.excluded_from_ai_at).toBeTruthy();
    expect((await msg(after))?.excluded_from_ai_at).toBeTruthy();
    const { data: rec } = await a.from("memory_deletions").select("scope").eq("memory_id", orphan).single();
    expect(rec?.scope).toBe("conversation");

    // 消えた記憶への提案
    const q = await req(r);
    expect(q?.proposed_text).toBeNull();
    expect(q?.reason).toBeNull();
    expect(q?.status).toBe("dismissed");

    // 2回目は何も変えない
    const { data: second } = await admin.rpc("repair_deletion_leftovers");
    expect(second).toEqual({ orphan_versions_deleted: 0, messages_excluded: 0, requests_scrubbed: 0 });
  });
});

// =============================================================
// 会話の削除の記録（R1）の越境と、共通の手順の守り
// =============================================================
describe("会話の削除の記録と共通の手順は、本人の分しか扱えない", () => {
  it("A は B の会話の削除の記録を読めない・作れない。記録は書き換え・取り消しできない", async () => {
    const { data: seen } = await a.from("conversation_deletions").select("id").eq("user_id", idB);
    expect(seen).toEqual([]);

    const { error: ins } = await a
      .from("conversation_deletions")
      .insert({ user_id: idB, conversation_id: crypto.randomUUID() });
    expect(ins?.code).toBe("42501");

    const G = await conv("R1");
    await a.rpc("delete_conversation_with_memories", { target: G });
    const { data: mine } = await a.from("conversation_deletions").select("id").eq("conversation_id", G).single();

    await a.from("conversation_deletions").update({ deleted_at: "2000-01-01T00:00:00Z" }).eq("id", mine!.id);
    await a.from("conversation_deletions").delete().eq("id", mine!.id);
    const { data: still } = await a.from("conversation_deletions").select("deleted_at").eq("id", mine!.id).single();
    expect(still?.deleted_at).not.toContain("2000-01-01");

    const anon = client(anonKey);
    const { data: anonSeen } = await anon.from("conversation_deletions").select("id");
    expect(anonSeen ?? []).toEqual([]);
  });

  it("本人は、共通の手順・記録を書く処理を、画面の API から直接呼べない", async () => {
    const H = await conv("共通の手順");
    const q = await say(H, "user", `${TAG} 共通の手順の確認`);
    const M = await memory(H, q, `${TAG}-common 確認`);

    // public には無い（以前の場所で呼ぼうとしても見つからない）
    for (const [fn, args] of [
      ["delete_memory_chain", { target: M, in_scope: "conversation" }],
      ["record_memory_deletions", { ids: [M], in_scope: "conversation" }],
      ["record_conversation_deletion", { target: H }],
    ] as const) {
      const { error } = await a.rpc(fn, args);
      expect(error, fn).not.toBeNull();
      // 置き場所（app_private）を名指ししても、API には出ていない
      const { error: e2 } = await a.schema("app_private").rpc(fn, args);
      expect(e2, `app_private.${fn}`).not.toBeNull();
    }

    // 何も起きていない：記憶は残り、削除の記録も会話の削除の記録も無い
    expect((await mem(M))?.status).toBe("confirmed");
    const { data: d } = await a.from("memory_deletions").select("id").eq("memory_id", M);
    expect(d).toEqual([]);
    const { data: cd } = await a.from("conversation_deletions").select("id").eq("conversation_id", H);
    expect(cd).toEqual([]);
  });

  it("本人は、削除の記録・会話の削除の記録を直接書けない（自分の分でも）", async () => {
    const H = await conv("直接の記録");
    const q = await say(H, "user", `${TAG} 直接の記録の確認`);
    const M = await memory(H, q, `${TAG}-direct 確認`);

    const { error: e1 } = await a.from("memory_deletions").insert({
      user_id: idA,
      memory_id: M,
      source_message_id: q,
      conversation_id: H,
      scope: "conversation",
    });
    expect(e1?.code).toBe("42501");

    const { error: e2 } = await a.from("conversation_deletions").insert({ user_id: idA, conversation_id: H });
    expect(e2?.code).toBe("42501");

    expect((await mem(M))?.status).toBe("confirmed");
  });

  it("他人（B）は、Aの記憶も会話も消せない", async () => {
    const H = await conv("他人");
    const q = await say(H, "user", `${TAG} 他人の確認`);
    const M = await memory(H, q, `${TAG}-other 確認`);

    const { data: m } = await b.rpc("delete_memory", { target: M });
    expect(m).toBe(0);
    const { data: c } = await b.rpc("delete_conversation_with_memories", { target: H });
    expect(c).toBe(0);
    expect((await mem(M))?.status).toBe("confirmed");
    expect(await screen(H)).toContain(`${TAG} 他人の確認`);
  });
});

// =============================================================
// C2：削除の記録の範囲は、実際に行った操作と必ず一致する
// =============================================================
describe("C2 削除の記録の範囲は、実際の操作と一致する", () => {
  async function scopes(ids: string[]): Promise<Record<string, string>> {
    const { data } = await a.from("memory_deletions").select("memory_id, scope").in("memory_id", ids);
    return Object.fromEntries((data ?? []).map((r) => [r.memory_id as string, r.scope as string]));
  }

  it("記憶だけ消す → 系列のすべての版が「記憶だけ」", async () => {
    const H = await conv("範囲-記憶だけ");
    const q = await say(H, "user", `${TAG} 範囲の確認1`);
    const M1 = await memory(H, q, `${TAG}-scope1 元`);
    const q2 = await say(H, "user", `${TAG} 範囲の確認1の訂正`);
    const { data: M2 } = await a.rpc("revise_memory", {
      target: M1, kind: "correction", new_text: `${TAG}-scope1 新`, in_conversation: H, in_message: q2,
    });

    await a.rpc("delete_memory", { target: M2 });

    expect(await scopes([M1, M2 as string])).toEqual({ [M1]: "memory_only", [M2 as string]: "memory_only" });
  });

  it("会話ごと消す → 別の会話にある版も含めて「会話ごと」", async () => {
    const A = await conv("範囲-会話ごとA");
    const qa = await say(A, "user", `${TAG} 範囲の確認2`);
    const M1 = await memory(A, qa, `${TAG}-scope2 元`);
    const B = await conv("範囲-会話ごとB");
    const qb = await say(B, "user", `${TAG} 範囲の確認2の訂正`);
    const { data: M2 } = await a.rpc("revise_memory", {
      target: M1, kind: "correction", new_text: `${TAG}-scope2 新`, in_conversation: B, in_message: qb,
    });

    await a.rpc("delete_conversation_with_memories", { target: A });

    expect(await scopes([M1, M2 as string])).toEqual({ [M1]: "conversation", [M2 as string]: "conversation" });
  });

  it("先に記憶だけ消した記憶は、あとで会話ごと消しても「記憶だけ」のまま（実際にそう消したため）", async () => {
    const H = await conv("範囲-先に記憶だけ");
    const q1 = await say(H, "user", `${TAG} 範囲の確認3`);
    const first = await memory(H, q1, `${TAG}-scope3 先に消す`);
    const q2 = await say(H, "user", `${TAG} 範囲の確認3の2`);
    const later = await memory(H, q2, `${TAG}-scope3 あとで会話ごと`);

    await a.rpc("delete_memory", { target: first });
    await a.rpc("delete_conversation_with_memories", { target: H });

    expect(await scopes([first, later])).toEqual({ [first]: "memory_only", [later]: "conversation" });
  });
});

// =============================================================
// 別の利用者には一切影響しない
// =============================================================
describe("別の利用者（B）には影響しない", () => {
  it("このファイルのすべての操作の後も、B の行の件数・記憶・印は変わっていない", async () => {
    expect(await countsOf(b, idB)).toEqual(bCountsBefore);
  });
});

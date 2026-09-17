/**
 * 本人向けデータ書き出しのテスト（Phase 4B）。
 *
 * いちばん確かめたいこと。
 *   ① 本人のデータだけが入る（ほかの人のものは1件も入らない）
 *   ② 消したものが、書き出し経由で復活しない
 *   ③ 別の場所へ持っていっても、関係が失われない
 *
 * 実際の開発用 Supabase へ、アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import { buildExport } from "@/lib/export/build";
import {
  EXPORT_FILES,
  EXPORT_FORMAT_VERSION,
  FORBIDDEN_IN_EXPORT,
  NOT_EXPORTED,
  REQUIRED_FILES,
  EXPORT_STORAGE,
} from "@/config/export";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const SECRET_OF_B = "Bだけの記憶。Aの書き出しに入ってはいけない";
const DELETED_TEXT = "これは消される予定の内容です";
const REJECTED_TEXT = "これは残さないと決められる内容です";

type Row = Record<string, unknown>;

let a: SupabaseClient;
let b: SupabaseClient;
let idA: string;
let idB: string;
let convA: string;
let convB: string;

/** 書き出したファイルを開いて、中のJSONを読む */
async function openExport(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => JSON.parse(await zip.file(name)!.async("string"));
  const names = Object.keys(zip.files);
  let allText = "";
  for (const n of names) allText += await zip.file(n)!.async("string");
  return {
    names,
    allText,
    manifest: (await read(EXPORT_FILES.manifest)) as Row,
    conversations: (await read(EXPORT_FILES.conversations)) as Row[],
    messages: (await read(EXPORT_FILES.messages)) as Row[],
    memories: (await read(EXPORT_FILES.memories)) as Row[],
    references: (await read(EXPORT_FILES.references)) as Row[],
  };
}

async function signIn(email: string, password: string) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { client, userId: data.user!.id };
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");

  ({ client: a, userId: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ client: b, userId: idB } = await signIn("kasshi-test-b@example.com", pb));

  // --- Aさんのデータ（あらゆる状態を1つずつ） ---
  const { data: ca } = await a
    .from("conversations")
    .insert({ user_id: idA, title: "書き出しテスト（A）" })
    .select("id")
    .single();
  convA = ca!.id as string;

  const say = async (content: string, role: "user" | "assistant" = "user") => {
    const { data } = await a
      .from("messages")
      .insert({ conversation_id: convA, user_id: idA, role, content })
      .select("id")
      .single();
    return data!.id as string;
  };
  const candidate = async (src: string, text: string, patch: Row = {}) => {
    const { data, error } = await a
      .from("memory_candidates")
      .insert({
        user_id: idA,
        conversation_id: convA,
        source_message_id: src,
        candidate_index: 1,
        suggested_text: text,
        extraction_reason: `理由：${text}`,
        origin: "self_experience",
        status: "pending",
        ...patch,
      })
      .select("id")
      .single();
    if (error) throw new Error(`候補: ${error.message}`);
    return data.id as string;
  };

  // いまの記憶（本人が文章を直したもの）
  const q1 = await say("まとめ買いの話をします。");
  const m1 = await candidate(q1, "まとめ買いは春にする");
  await a
    .from("memory_candidates")
    .update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
      confirmed_text: "値上がり前の春に、年間ぶんをまとめ買いする",
    })
    .eq("id", m1);

  // 訂正（前の版は superseded）
  const q2 = await say("締め日は20日です。");
  await say("20日なんですね。", "assistant");
  const m2 = await candidate(q2, "締め日は毎月20日");
  await a
    .from("memory_candidates")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", m2);
  const q2b = await say("違う、25日でした。");
  await a.rpc("revise_memory", {
    target: m2,
    kind: "correction",
    new_text: "締め日は毎月25日",
    in_conversation: convA,
    in_message: q2b,
    note: "本人が訂正",
  });

  // 考えの変化（前の版は archived）
  const q3 = await say("小さく試すのを大切にしています。");
  const m3 = await candidate(q3, "小さく試すのを大切にしている");
  await a
    .from("memory_candidates")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", m3);
  const q3b = await say("考えが変わりました。");
  await a.rpc("revise_memory", {
    target: m3,
    kind: "update",
    new_text: "先に全体を決めた方がよいと思っている",
    in_conversation: convA,
    in_message: q3b,
    note: null,
  });

  // 削除（出典つき）
  const q4 = await say(DELETED_TEXT);
  const m4 = await candidate(q4, DELETED_TEXT);
  await a
    .from("memory_candidates")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", m4);
  const r4 = await say("その件、うかがっていました。", "assistant");
  await a.from("memory_references").insert({ user_id: idA, message_id: r4, memory_id: m4 });
  await a.rpc("delete_memory", { target: m4 });

  // 確認待ち
  const q5 = await say("確認待ちになる話です。");
  await candidate(q5, "確認待ちの内容");

  // 残さないと決めた
  const q6 = await say(REJECTED_TEXT);
  const m6 = await candidate(q6, REJECTED_TEXT);
  await a
    .from("memory_candidates")
    .update({
      status: "rejected",
      confirmed_at: new Date().toISOString(),
      suggested_text: null,
      confirmed_text: null,
      extraction_reason: null,
    })
    .eq("id", m6);

  // --- Bさんのデータ（混ざらないことの確認用） ---
  const { data: cb } = await b
    .from("conversations")
    .insert({ user_id: idB, title: "Bの会話（書き出しテスト）" })
    .select("id")
    .single();
  convB = cb!.id as string;
  const { data: mb } = await b
    .from("messages")
    .insert({ conversation_id: convB, user_id: idB, role: "user", content: SECRET_OF_B })
    .select("id")
    .single();
  await b.from("memory_candidates").insert({
    user_id: idB,
    conversation_id: convB,
    source_message_id: mb!.id,
    candidate_index: 1,
    suggested_text: SECRET_OF_B,
    origin: "self_experience",
    status: "confirmed",
    confirmed_at: new Date().toISOString(),
  });
}, 60_000);

afterAll(async () => {
  if (convA) await a.from("conversations").delete().eq("id", convA);
  if (convB) await b.from("conversations").delete().eq("id", convB);
});

// =============================================================
// ① 本人のデータだけが入る
// =============================================================
describe("本人のデータだけが入る", () => {
  it("Aさんの書き出しに、Bさんの内容が1件も入らない", async () => {
    const result = await buildExport(a, idA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const x = await openExport(result.zip);
    expect(x.allText).not.toContain(SECRET_OF_B);
    expect(x.allText).not.toContain(idB);
    expect(x.allText).not.toContain(convB);
  });

  it("ほかの人のIDを指定しても、その人のデータは取れない", async () => {
    /* 画面から「誰のぶんか」を送りつけられた場合の備え。
       受け口では本人の情報からしか決めないが、
       もし誤って他人のIDを渡しても、DBの決まり（RLS）で何も返らない。 */
    const result = await buildExport(a, idB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const x = await openExport(result.zip);
    expect(x.conversations).toHaveLength(0);
    expect(x.messages).toHaveLength(0);
    expect(x.memories).toHaveLength(0);
    expect(x.allText).not.toContain(SECRET_OF_B);
  });

  it("未ログインでは、そもそもファイルが作られない", async () => {
    /* 未ログインだと、DBを読む段階で断られる。
       中身が空のファイルを渡すのではなく、**何も作らない**。 */
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await buildExport(anon, idA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed");
  });

  it("Bさんの書き出しには、Aさんの内容が入らない", async () => {
    const result = await buildExport(b, idB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const x = await openExport(result.zip);
    expect(x.allText).not.toContain(idA);
    expect(x.allText).not.toContain(convA);
    expect(x.allText).toContain(SECRET_OF_B); // 自分のものは入る
  });
});

// =============================================================
// ② 消したものが復活しない
// =============================================================
describe("消したものが、書き出し経由で復活しない", () => {
  it("消した記憶の本文が入らない", async () => {
    const result = await buildExport(a, idA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const x = await openExport(result.zip);
    const deleted = x.memories.filter((m) => m.status === "deleted");
    expect(deleted.length).toBeGreaterThan(0);
    for (const m of deleted) {
      expect(m.text).toBeNull();
      expect(m.aiSuggestedText).toBeNull();
      expect(m.confirmedText).toBeNull();
    }
    // 記憶の一覧に、消した本文が1文字も出てこない
    expect(JSON.stringify(x.memories)).not.toContain(DELETED_TEXT);
  });

  it("「残さない」と決めた候補の本文が入らない", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const rejected = x.memories.filter((m) => m.status === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const m of rejected) {
      expect(m.text).toBeNull();
      expect(m.aiSuggestedText).toBeNull();
    }
    expect(JSON.stringify(x.memories)).not.toContain(REJECTED_TEXT);
  });

  it("消した記憶にも、消したという事実と日時は残る", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    for (const m of x.memories.filter((m) => m.status === "deleted")) {
      expect(m.deletedAt).toBeTruthy();
      expect(m.statusLabel).toContain("本文は残っていません");
    }
  });

  it("消した記憶を参考にした返事は、記録として残る", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const deletedIds = new Set(
      x.memories.filter((m) => m.status === "deleted").map((m) => String(m.id)),
    );
    const pointing = x.references.filter((r) => deletedIds.has(String(r.memoryId)));
    expect(pointing.length).toBeGreaterThan(0); // 参考にした事実は残る
  });

  it("記憶を消しても元の会話は残るが、AIへ送らない印が付いている", async () => {
    /* Phase 3C で決めたとおり、記憶だけ消しても会話は残る（本人が読み返せる）。
       ただし、その会話はAIの返事には使われない。その印も一緒に書き出す。 */
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const said = x.messages.find((m) => String(m.content).includes(DELETED_TEXT));
    expect(said).toBeTruthy();
    expect(said!.excludedFromAiAt).toBeTruthy();
    expect(said!.exclusionReason).toBe("deleted");
    expect(String(said!.exclusionReasonLabel)).toContain("返事には使いません");
  });
});

// =============================================================
// ③ 関係が失われない
// =============================================================
describe("別の場所へ持っていっても、関係が分かる", () => {
  it("いまの記憶と、昔の考えを区別できる", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    expect(x.memories.some((m) => m.status === "confirmed")).toBe(true);
    expect(x.memories.some((m) => m.status === "archived")).toBe(true);
    expect(x.memories.some((m) => m.status === "superseded")).toBe(true);
  });

  it("訂正と、考えの変化を区別できる", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const kinds = x.memories.map((m) => m.revisionKind).filter(Boolean);
    expect(kinds).toContain("correction");
    expect(kinds).toContain("update");
  });

  it("前の版と次の版が、たがいを指し合っている", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const byId = new Map(x.memories.map((m) => [String(m.id), m]));
    const revised = x.memories.filter((m) => m.revisionOf);
    expect(revised.length).toBeGreaterThan(0);

    for (const m of revised) {
      const prev = byId.get(String(m.revisionOf));
      expect(prev).toBeTruthy();
      expect(prev!.supersededBy).toBe(m.id);
      expect(Number(m.version)).toBeGreaterThan(Number(prev!.version));
    }
  });

  it("記憶と、もとになった発言がつながっている", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const msgIds = new Set(x.messages.map((m) => String(m.id)));
    for (const m of x.memories) {
      expect(msgIds.has(String(m.sourceMessageId))).toBe(true);
    }
  });

  it("会話と発言がつながっている", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const convIds = new Set(x.conversations.map((c) => String(c.id)));
    for (const m of x.messages) {
      expect(convIds.has(String(m.conversationId))).toBe(true);
    }
  });

  it("情報の由来が残っている", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    for (const m of x.memories) {
      expect(m.origin).toBeTruthy();
      expect(m.originLabel).toBeTruthy();
    }
  });

  it("AIの案と、本人が直した文章を区別できる", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const edited = x.memories.filter((m) => m.editedByOwner);
    expect(edited.length).toBeGreaterThan(0);
    for (const m of edited) {
      expect(m.aiSuggestedText).toBeTruthy();
      expect(m.confirmedText).toBeTruthy();
      expect(m.aiSuggestedText).not.toBe(m.confirmedText);
      expect(m.confirmedAt).toBeTruthy(); // 本人が確定した日時
    }
  });

  it("出典が、返事と記憶をつないでいる", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    const msgIds = new Set(x.messages.map((m) => String(m.id)));
    const memIds = new Set(x.memories.map((m) => String(m.id)));
    expect(x.references.length).toBeGreaterThan(0);
    for (const r of x.references) {
      expect(msgIds.has(String(r.messageId))).toBe(true);
      if (r.memoryId) expect(memIds.has(String(r.memoryId))).toBe(true);
    }
  });
});

// =============================================================
// ④ 形と、入れてはいけないもの
// =============================================================
describe("ファイルの形", () => {
  it("必要なファイルがすべて入っている", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    for (const name of REQUIRED_FILES) expect(x.names).toContain(name);
    expect(x.names).toContain(EXPORT_FILES.readme);
  });

  it("形の版が入っている（将来、形が変わっても読み分けられる）", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    expect(x.manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
  });

  it("目録に、必要なことが書いてある", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    expect(x.manifest.exportedAt).toBeTruthy();
    expect(x.manifest.ownerUserId).toBe(idA);
    expect(x.manifest.counts).toBeTruthy();
    expect(Array.isArray(x.manifest.files)).toBe(true);
    expect((x.manifest.notExported as unknown[]).length).toBe(NOT_EXPORTED.length);
  });

  it("入っていないものに、必ず理由が書いてある", () => {
    for (const item of NOT_EXPORTED) expect(item.reason.length).toBeGreaterThan(10);
  });

  it("鍵・APIキー・パスワードが入っていない", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    for (const word of FORBIDDEN_IN_EXPORT) expect(x.allText).not.toContain(word);
    expect(x.allText).not.toContain("password");
  });

  it("AIの利用量の記録は入らない（理由つきで断ってある）", async () => {
    const result = await buildExport(a, idA);
    if (!result.ok) throw new Error("書き出せませんでした");

    const x = await openExport(result.zip);
    expect(x.names).not.toContain("ai_usage.json");
    expect(x.allText).not.toContain("estimated_cost");
    expect(x.allText).not.toContain("claude-sonnet");
    expect(JSON.stringify(x.manifest.notExported)).toContain("ai_usage");
  });

  it("サーバーにファイルを残さない決まりになっている", () => {
    expect(EXPORT_STORAGE.storeOnServer).toBe(false);
  });
});

/**
 * 振り返りPDFのテスト（Phase 4C）。
 *
 * いちばん確かめたいこと。
 *   **本人が確定した内容だけを、意味を変えず、
 *     削除済み・未確定のものを混ぜずに読み返せること。**
 *
 * PDFは「作れた」だけでは合格にしない。
 * **PDFを開いた人に何が見えるか**（実際に書かれている文字）を取り出して調べる。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdf } from "@/lib/pdf/build";
import { collectPdfContent } from "@/lib/pdf/collect";
import { wrapJapanese } from "@/lib/pdf/render";
import { PDF_EXCLUDES, PDF_ORIGIN_LABEL, PDF_STORAGE, isPdfPeriod } from "@/config/pdf";
import { monthRangeJst } from "@/lib/time";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

// 架空データ（PDFに出る／出ないを見分けるための目印）
const KEPT = "新商品は、小さく試して反応を見てから広げる";
const EDITED_AI = "青森ひばの仕入れは春に多めに頼んでいる";
const EDITED_OWNER = "青森ひばは、値上がりする前の春のうちに、年間ぶんをまとめて仕入れる";
const THIRD_PARTY = "取引先によると、来年は木材が値上がりする見込み";
const ADOPTED = "展示会では、ブースを小さくして一人ずつ長く話す";
const BEFORE_FIX = "仕入先の締め日は毎月20日";
const AFTER_FIX = "仕入先の締め日は毎月25日";
const OLD_THOUGHT = "小さく試すことを大切にしている";
const NEW_THOUGHT = "ブランド設計だけは最初にしっかり決める方がよいと考えている";
const DELETED = "昨年の健康診断で、血圧が少し高めと言われた";
const PENDING = "確認待ちの内容。PDFに出てはいけない";
const AI_ONLY = "AIが提案しただけの案。本人は採用していない";
const SECRET_OF_B = "Bだけの記憶。AさんのPDFに出てはいけない";

let a: SupabaseClient;
let b: SupabaseClient;
let idA: string;
let idB: string;
let convA: string;
let convB: string;

/** PDFに実際に書かれている文字を取り出す */
async function readPdf(bytes: Uint8Array) {
  const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
  let all = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    all += content.items.map((x) => ("str" in x ? x.str : "")).join("");
  }
  return { pages: doc.numPages, text: all };
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

  const { data: ca } = await a
    .from("conversations")
    .insert({ user_id: idA, title: "新商品の相談" })
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
  const candidate = async (src: string, text: string, patch: Record<string, unknown> = {}) => {
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
  const confirm = async (id: string, edited?: string) => {
    await a
      .from("memory_candidates")
      .update({
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        ...(edited ? { confirmed_text: edited } : {}),
      })
      .eq("id", id);
  };

  // 載るもの
  await confirm(await candidate(await say("新商品の話です。"), KEPT));
  await confirm(await candidate(await say("青森ひばの話です。"), EDITED_AI), EDITED_OWNER);
  await confirm(await candidate(await say("取引先の話です。"), THIRD_PARTY, { origin: "third_party" }));
  await confirm(await candidate(await say("展示会の話です。"), ADOPTED, { origin: "ai_adopted" }));

  // 訂正
  const q1 = await say("締め日は20日です。");
  const m1 = await candidate(q1, BEFORE_FIX);
  await confirm(m1);
  const q1b = await say("違う、25日でした。");
  await a.rpc("revise_memory", {
    target: m1,
    kind: "correction",
    new_text: AFTER_FIX,
    in_conversation: convA,
    in_message: q1b,
    note: "本人が訂正",
  });

  // 考えの変化
  const q2 = await say("小さく試すことを大切にしています。");
  const m2 = await candidate(q2, OLD_THOUGHT);
  await confirm(m2);
  const q2b = await say("考えが変わりました。");
  await a.rpc("revise_memory", {
    target: m2,
    kind: "update",
    new_text: NEW_THOUGHT,
    in_conversation: convA,
    in_message: q2b,
    note: null,
  });

  // 載ってはいけないもの
  const q3 = await say("健康の話です。");
  const m3 = await candidate(q3, DELETED);
  await confirm(m3);
  await a.rpc("delete_memory", { target: m3 });

  await candidate(await say("確認待ちの話です。"), PENDING);

  const q4 = await say("残さない話です。");
  const m4 = await candidate(q4, "残さないと決めた内容");
  await a
    .from("memory_candidates")
    .update({
      status: "rejected",
      confirmed_at: new Date().toISOString(),
      suggested_text: null,
      confirmed_text: null,
      extraction_reason: null,
    })
    .eq("id", m4);

  const q5 = await say("期限切れの話です。");
  const m5 = await candidate(q5, "期限切れの内容", {
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  await a
    .from("memory_candidates")
    .update({
      status: "expired",
      suggested_text: null,
      confirmed_text: null,
      extraction_reason: null,
    })
    .eq("id", m5);

  await confirm(await candidate(await say("AIの案の話です。"), AI_ONLY, { origin: "ai_suggestion" }));

  // --- Bさん ---
  const { data: cb } = await b
    .from("conversations")
    .insert({ user_id: idB, title: "Bの会話（PDFテスト）" })
    .select("id")
    .single();
  convB = cb!.id as string;
  const { data: mb } = await b
    .from("messages")
    .insert({ conversation_id: convB, user_id: idB, role: "user", content: "Bだけの発言です。" })
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
}, 90_000);

afterAll(async () => {
  if (convA) await a.from("conversations").delete().eq("id", convA);
  if (convB) await b.from("conversations").delete().eq("id", convB);
});

// =============================================================
// 本人が確定した内容だけが載る
// =============================================================
describe("本人が確定した内容だけが載る", () => {
  it("いま有効な記憶が、そのまま載る", async () => {
    const r = await buildPdf(a, idA, "this");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(KEPT);
    expect(text).toContain(THIRD_PARTY);
    expect(text).toContain(ADOPTED);
  });

  it("本人が直した記憶は、本人の文章のほうが載る", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(EDITED_OWNER);
    // AIの案のほうは載せない（本人が直したのだから）
    expect(text).not.toContain(EDITED_AI);
  });

  it("確認待ちの候補は載らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain(PENDING);
  });

  it("「残さない」と決めた候補は載らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain("残さないと決めた内容");
  });

  it("期限が過ぎた候補は載らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain("期限切れの内容");
  });

  it("消した記憶の本文は、1文字も載らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain(DELETED);
    expect(text).not.toContain("血圧");
    expect(text).not.toContain("健康診断");
  });

  it("消した件数も載せない（消した内容を推測させないため）", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain("削除した内容");
    expect(text).not.toMatch(/消した内容が\d+件/);
  });

  it("本人が採用していないAIの提案は載らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain(AI_ONLY);
  });
});

// =============================================================
// 意味を変えない
// =============================================================
describe("情報の性質を変えない", () => {
  it("本人の経験・第三者の発言・検討中の案を、それぞれの言い方で書く", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(PDF_ORIGIN_LABEL.self_experience);
    expect(text).toContain(PDF_ORIGIN_LABEL.third_party);
    expect(text).toContain(PDF_ORIGIN_LABEL.ai_adopted);
  });

  it("第三者の発言を、客観的な事実のように書かない", () => {
    // 「〜が話したと本人が紹介した」という形を保つ
    expect(PDF_ORIGIN_LABEL.third_party).toContain("ご本人が紹介した");
    expect(PDF_ORIGIN_LABEL.third_party).not.toContain("事実");
  });

  it("AIの案を採用したものを、本人が自分で考えたことにしない", () => {
    expect(PDF_ORIGIN_LABEL.ai_adopted).toContain("AIカッシーの案");
    expect(PDF_ORIGIN_LABEL.ai_adopted).toContain("ご本人が採用");
  });

  it("本人の考えを、断定した事実に書き換えない", () => {
    expect(PDF_ORIGIN_LABEL.self_experience).toContain("ご本人の");
    expect(PDF_ORIGIN_LABEL.tentative).toContain("検討中");
  });
});

// =============================================================
// 訂正と考えの変化
// =============================================================
describe("訂正と考えの変化の書き分け", () => {
  it("考えの変化では、以前と現在の両方が載り、間違いではないと書く", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(OLD_THOUGHT);
    expect(text).toContain(NEW_THOUGHT);
    expect(text).toContain("以前の考えが間違いだったという意味ではありません");
  });

  it("訂正では、訂正前と現在の両方が載り、前の内容は使わないと書く", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(BEFORE_FIX);
    expect(text).toContain(AFTER_FIX);
    expect(text).toContain("訂正前の内容は、現在の回答には使われません");
  });

  it("訂正と考えの変化は、別の見出しに分かれている", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain("変わった考え");
    expect(text).toContain("訂正したこと");
  });

  it("元の会話と、確定した日が分かる", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain("元の会話：新商品の相談");
    expect(text).toMatch(/残した日：\d{4}年\d{1,2}月\d{1,2}日/);
  });
});

// =============================================================
// ほかの人のものが混ざらない
// =============================================================
describe("ほかの人のものが混ざらない", () => {
  it("AさんのPDFに、Bさんの内容もIDも入らない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain(SECRET_OF_B);
    expect(text).not.toContain("Bだけの発言");
    expect(text).not.toContain(idB);
  });

  it("BさんのPDFに、Aさんの内容が入らない", async () => {
    const r = await buildPdf(b, idB, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).toContain(SECRET_OF_B);
    expect(text).not.toContain(KEPT);
    expect(text).not.toContain(AFTER_FIX);
  });

  it("ほかの人のIDを指定しても、その人の内容は出ない", async () => {
    const r = await buildPdf(a, idB, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).not.toContain(SECRET_OF_B);
    expect(text).toContain("この期間に、カッシーへ残した内容はありませんでした");
  });

  it("未ログインでは、そもそもPDFが作られない", async () => {
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const r = await buildPdf(anon, idA, "this");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("failed");
  });

  it("内部の番号（ID）がPDFに出ない", async () => {
    const r = await buildPdf(a, idA, "this");
    if (!r.ok) throw new Error("作れませんでした");

    const { text } = await readPdf(r.pdf);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain("user_id");
  });
});

// =============================================================
// 期間・空・作っている最中の変更
// =============================================================
describe("期間と、作っている最中の変更", () => {
  it("今月と先月を、日本時間で正しく分ける", () => {
    const now = new Date("2026-09-01T00:30:00+09:00"); // 日本時間の9月1日 0時半
    const thisMonth = monthRangeJst(0, now);
    const lastMonth = monthRangeJst(-1, now);
    expect(thisMonth.label).toBe("2026年9月");
    expect(lastMonth.label).toBe("2026年8月");
    // 月の変わり目：日本時間の9月1日 0時ちょうどから今月
    expect(thisMonth.start.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });

  it("世界標準時では前日でも、日本時間で判断する", () => {
    // 日本時間 9月1日 8時＝世界標準時 8月31日 23時
    const now = new Date("2026-08-31T23:00:00Z");
    expect(monthRangeJst(0, now).label).toBe("2026年9月");
  });

  it("期間の指定が変でも、今月として扱う", () => {
    expect(isPdfPeriod("this")).toBe(true);
    expect(isPdfPeriod("last")).toBe(true);
    expect(isPdfPeriod("next")).toBe(false);
    expect(isPdfPeriod(null)).toBe(false);
  });

  it("何も無い期間でも、エラーにならず案内が出る", async () => {
    const r = await buildPdf(a, idA, "last"); // 先月は何も無い
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.summary.isEmpty).toBe(true);
    const { text } = await readPdf(r.pdf);
    expect(text).toContain("この期間に、カッシーへ残した内容はありませんでした");
  });

  it("作っている最中に記憶が変わったら、古いPDFを渡さない", async () => {
    const { data: target } = await a
      .from("confirmed_memories")
      .select("id")
      .eq("user_id", idA)
      .limit(1)
      .maybeSingle();
    expect(target).toBeTruthy();

    const [result] = await Promise.all([
      buildPdf(a, idA, "this"),
      (async () => {
        await new Promise((r) => setTimeout(r, 60));
        await a.rpc("delete_memory", { target: target!.id });
      })(),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("changed");
    expect(result.message).toContain("古い内容のPDFはお渡ししません");
  });
});

// =============================================================
// 作り方の決まり
// =============================================================
describe("作り方の決まり", () => {
  it("サーバーにPDFを保存しない", () => {
    expect(PDF_STORAGE.storeOnServer).toBe(false);
  });

  it("載せないものに、必ず理由が書いてある", () => {
    expect(PDF_EXCLUDES.length).toBeGreaterThan(5);
    for (const e of PDF_EXCLUDES) expect(e.reason.length).toBeGreaterThan(5);
  });

  it("本人の機器に保存したPDFは消せない、と案内する", async () => {
    const r = await buildPdf(a, idA, "last");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).toContain("AIカッシー側から削除できません");
  });

  it("PDFは、すべてのデータではないと断る", async () => {
    const r = await buildPdf(a, idA, "last");
    if (!r.ok) throw new Error("作れませんでした");
    const { text } = await readPdf(r.pdf);
    expect(text).toContain("カッシーに残してあるものすべてではありません");
  });
});

// =============================================================
// 日本語の折り返し
// =============================================================
describe("日本語の折り返し", () => {
  const fakeFont = {
    widthOfTextAtSize: (t: string, size: number) => t.length * size,
  } as unknown as Parameters<typeof wrapJapanese>[1];

  it("紙の幅で折り返す", () => {
    const lines = wrapJapanese("あいうえおかきくけこ", fakeFont, 10, 50);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(6);
  });

  it("行の先頭に句点や閉じカッコが来ない", () => {
    const lines = wrapJapanese("あいうえお。かきくけこ」", fakeFont, 10, 50);
    for (const line of lines) {
      expect("、。）」".includes(line[0] ?? "")).toBe(false);
    }
  });

  it("空の文字列でも落ちない", () => {
    expect(wrapJapanese("", fakeFont, 10, 100)).toEqual([""]);
  });

  it("折り返しても、文字は1つも失われない", () => {
    const text = "十和田の工房では、青森ひばを使った小物を作っています（値上がり前に仕入れます）。";
    const lines = wrapJapanese(text, fakeFont, 10, 80);
    expect(lines.join("")).toBe(text);
  });
});

// =============================================================
// 集める段階の絞り込み
// =============================================================
describe("集める段階で、余計なものを外している", () => {
  it("PDFに渡す時点で、消したもの・未確定のものが入っていない", async () => {
    const content = await collectPdfContent(a, idA, "this");
    const all = [
      ...content.kept.map((m) => m.text),
      ...content.changed.flatMap((r) => [r.before, r.after]),
      ...content.corrected.flatMap((r) => [r.before, r.after]),
    ].join("\n");

    expect(all).not.toContain(DELETED);
    expect(all).not.toContain(PENDING);
    expect(all).not.toContain(AI_ONLY);
    expect(all).not.toContain(SECRET_OF_B);
  });

  it("由来が、すべての記憶に付いている", async () => {
    const content = await collectPdfContent(a, idA, "this");
    for (const m of content.kept) {
      expect(PDF_ORIGIN_LABEL[m.origin]).toBeTruthy();
    }
  });
});

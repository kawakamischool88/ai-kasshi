/**
 * `/cost`（運営用の原価画面）が、管理者だけのものになっているかのテスト。
 *
 * 【役名】
 *   管理者A     … kasshi-test-admin@example.com（profiles.role = 'admin'）
 *   通常利用者B … kasshi-test-b@example.com    （profiles.role = 'user'）
 *   未ログイン  … anon
 *
 * 【一番大事なこと】
 * 画面を隠しただけでは守りにならない。
 * **画面を通らずに直接データを取りに行っても、原価が出てこないこと**を確かめる。
 * アプリと同じ anon キーで接続する（service_role は使わない）。
 */
import { config as loadEnv } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const EMAIL_ADMIN = "kasshi-test-admin@example.com";
const EMAIL_B = "kasshi-test-b@example.com";

/** 権限なしのとき Postgres が返すコード */
const PERMISSION_DENIED = "42501";
/** このテストで入れた記録の目印 */
const MARK = "test-admin-cost";

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

let admin: SupabaseClient;
let b: SupabaseClient;
let anon: SupabaseClient;
let idAdmin: string;
let idB: string;

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  const padmin = process.env.TEST_USER_ADMIN_PASSWORD ?? pa;
  if (!url || !anonKey || !pb || !padmin) {
    throw new Error(".env.test.local の設定が足りません（npm run seed を先に行ってください）");
  }

  ({ client: admin, userId: idAdmin } = await signIn(EMAIL_ADMIN, padmin));
  ({ client: b, userId: idB } = await signIn(EMAIL_B, pb));
  anon = newClient();
  expect(idAdmin).not.toBe(idB);

  /* 両者の原価記録を1件ずつ入れておく。
     「管理者には両方見える」「Bには自分のぶんしか見えない」を確かめるため。
     金額はごくわずかにして、しきい値の判定に影響を出さない。 */
  for (const [client, userId] of [
    [admin, idAdmin],
    [b, idB],
  ] as const) {
    const { error } = await client.from("ai_usage").insert({
      user_id: userId,
      operation_type: "chat",
      provider: "test",
      model: "test-model",
      estimated_cost: 0.000001,
      pricing_version: MARK,
      pricing_date: "2026-09-24",
      status: "success",
    });
    if (error) throw new Error(`利用記録の作成に失敗: ${error.message}`);
  }
});

// =============================================================
// 権限そのもの
// =============================================================
describe("権限の持ち方", () => {
  it("管理者Aは is_admin() が true", async () => {
    const { data, error } = await admin.rpc("is_admin");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("通常利用者Bは is_admin() が false", async () => {
    const { data, error } = await b.rpc("is_admin");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("未ログインでは is_admin() を呼べない、または false", async () => {
    const { data, error } = await anon.rpc("is_admin");
    expect(error !== null || data === false).toBe(true);
  });

  it("Bは自分を管理者にできない（自分の行の role を書き換えられない）", async () => {
    const { error } = await b.from("profiles").update({ role: "admin" }).eq("id", idB);
    expect(error).not.toBeNull();

    // 本当に変わっていないこと
    const { data } = await b.from("profiles").select("role").eq("id", idB).single();
    expect(data?.role).toBe("user");
    const { data: still } = await b.rpc("is_admin");
    expect(still).toBe(false);
  });

  it("Bは管理者Aの role も書き換えられない", async () => {
    const { data, error } = await b
      .from("profiles")
      .update({ role: "user" })
      .eq("id", idAdmin)
      .select("id");
    // 権限で弾かれるか、RLS で0件になるか。どちらでも「変えられていない」
    expect(error !== null || (data ?? []).length === 0).toBe(true);

    const { data: check } = await admin.rpc("is_admin");
    expect(check).toBe(true);
  });

  it("Bは role を admin にした行を作り足すこともできない", async () => {
    const { error } = await b
      .from("profiles")
      .insert({ id: crypto.randomUUID(), display_name: "x", role: "admin" });
    expect(error).not.toBeNull();
  });
});

// =============================================================
// 原価データそのもの（画面を通らない経路）
// =============================================================
describe("原価データ（API直接呼び出し）", () => {
  it("管理者Aは、全員ぶんの原価を取得できる", async () => {
    const { data, error } = await admin
      .from("ai_usage")
      .select("user_id, estimated_cost")
      .eq("pricing_version", MARK);

    expect(error).toBeNull();
    const owners = new Set((data ?? []).map((r) => r.user_id));
    expect(owners.has(idAdmin)).toBe(true);
    expect(owners.has(idB)).toBe(true);
  });

  it("通常利用者Bは、他人の原価を1件も取得できない", async () => {
    const { data, error } = await b.from("ai_usage").select("user_id");
    expect(error).toBeNull();
    expect((data ?? []).every((r) => r.user_id === idB)).toBe(true);
  });

  it("通常利用者Bは、管理者Aの記録を名指ししても取れない（0件）", async () => {
    const { data, error } = await b.from("ai_usage").select("id").eq("user_id", idAdmin);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("通常利用者Bは、全体の合計金額も出せない", async () => {
    const { data } = await b.from("ai_usage").select("estimated_cost");
    const sum = (data ?? []).reduce((s, r) => s + Number(r.estimated_cost ?? 0), 0);

    const { data: allRows } = await admin.from("ai_usage").select("estimated_cost");
    const adminSum = (allRows ?? []).reduce((s, r) => s + Number(r.estimated_cost ?? 0), 0);

    // 管理者から見える合計のほうが必ず大きい（両者に記録を入れてあるため）
    expect(adminSum).toBeGreaterThan(sum);
  });

  it("未ログインでは、原価を1件も取得できない", async () => {
    const { data, error } = await anon.from("ai_usage").select("id");
    expect(error?.code === PERMISSION_DENIED || (error === null && data?.length === 0)).toBe(true);
  });

  it("管理者Aでも、原価の記録は書き換え・削除できない", async () => {
    const { data: upd, error: ue } = await admin
      .from("ai_usage")
      .update({ estimated_cost: 999 })
      .eq("pricing_version", MARK)
      .select("id");
    expect(ue !== null || (upd ?? []).length === 0).toBe(true);

    const { data: del, error: de } = await admin
      .from("ai_usage")
      .delete()
      .eq("pricing_version", MARK)
      .select("id");
    expect(de !== null || (del ?? []).length === 0).toBe(true);
  });
});

// =============================================================
// 管理者になっても、会話や記憶までは見えない
// =============================================================
describe("管理者に広がりすぎていないこと", () => {
  it("管理者Aでも、他人の会話・発言・記憶は見えない", async () => {
    for (const table of ["conversations", "messages", "memory_candidates"]) {
      const { data, error } = await admin.from(table).select("user_id");
      expect(error).toBeNull();
      expect((data ?? []).every((r) => r.user_id === idAdmin)).toBe(true);
    }
  });

  it("管理者Aでも、他人の profiles は見えない", async () => {
    const { data, error } = await admin.from("profiles").select("id");
    expect(error).toBeNull();
    expect(data?.map((r) => r.id)).toEqual([idAdmin]);
  });
});

// =============================================================
// 通常利用者Bの、これまでの機能に影響が出ていないこと
// =============================================================
describe("通常利用者Bのふだんの機能", () => {
  it("会話を作り、発言を足し、読み直せる", async () => {
    const { data: conv, error: ce } = await b
      .from("conversations")
      .insert({ user_id: idB, title: "管理者テスト用の会話" })
      .select("id")
      .single();
    expect(ce).toBeNull();

    const convId = conv!.id as string;
    const { error: me } = await b
      .from("messages")
      .insert({ conversation_id: convId, user_id: idB, role: "user", content: "こんにちは" });
    expect(me).toBeNull();

    const { data: msgs } = await b.from("messages").select("content").eq("conversation_id", convId);
    expect(msgs?.map((m) => m.content)).toContain("こんにちは");

    await b.from("conversations").delete().eq("id", convId);
  });

  it("自分の原価は、これまで通り読める（原価停止の判定に使う）", async () => {
    const { data, error } = await b.from("ai_usage").select("estimated_cost").eq("user_id", idB);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("自分の表示名とメモは、これまで通り書き換えられる", async () => {
    const { data, error } = await b
      .from("profiles")
      .update({ memo: "Bのメモ" })
      .eq("id", idB)
      .select("memo");
    expect(error).toBeNull();
    expect(data).toEqual([{ memo: "Bのメモ" }]);
  });

  it("残してある内容の一覧（confirmed_memories）も、これまで通り引ける", async () => {
    const { error } = await b.from("confirmed_memories").select("id").limit(1);
    expect(error).toBeNull();
  });
});

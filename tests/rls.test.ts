/**
 * 最重要テスト：ユーザー越境アクセスが拒否されること。
 *
 * 架空ユーザー A・B（scripts/seed-test-users.ts で作成）でログインし、
 * A→B、B→A の 読取 / 作成 / 更新 / 削除 がすべて通らないことを確かめる。
 * あわせて、未ログイン（anon）では何も見えないことも確かめる。
 *
 * 前提：.env.test.local に SUPABASE_URL / SUPABASE_ANON_KEY /
 *       TEST_USER_A_PASSWORD / TEST_USER_B_PASSWORD がある。
 * アプリと同じ anon キーで接続する（service_role は使わない）。
 */
import { config as loadEnv } from "dotenv";
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const EMAIL_A = "kasshi-test-a@example.com";
const EMAIL_B = "kasshi-test-b@example.com";

/** RLS 違反のとき Postgres が返すコード */
const RLS_VIOLATION = "42501";

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

beforeAll(async () => {
  if (!url || !anonKey) throw new Error(".env.test.local に SUPABASE_URL / SUPABASE_ANON_KEY がありません");
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!pa || !pb) throw new Error(".env.test.local に TEST_USER_A_PASSWORD / TEST_USER_B_PASSWORD がありません");

  ({ client: a, userId: idA } = await signIn(EMAIL_A, pa));
  ({ client: b, userId: idB } = await signIn(EMAIL_B, pb));
  anon = newClient();
  expect(idA).not.toBe(idB);

  // 前回の実行で残った値を消し、既知の状態にそろえる
  await a.from("profiles").update({ display_name: "テスト利用者A", memo: "Aのメモ" }).eq("id", idA);
  await b.from("profiles").update({ display_name: "テスト利用者B", memo: "Bのメモ" }).eq("id", idB);
});

/** 越境テストを A→B と B→A の両方向で同じ内容で回す */
function crossUserSuite(label: string, me: () => SupabaseClient, myId: () => string, other: () => SupabaseClient, otherId: () => string) {
  describe(label, () => {
    it("読取：相手の行は見えない（一覧にも出ない）", async () => {
      const { data: byId, error } = await me().from("profiles").select("id").eq("id", otherId());
      expect(error).toBeNull();
      expect(byId).toEqual([]);

      const { data: all } = await me().from("profiles").select("id");
      expect(all?.map((r) => r.id)).toEqual([myId()]);
    });

    it("作成：相手の id を名乗った行は作れない", async () => {
      const { error } = await me().from("profiles").insert({ id: otherId(), display_name: "なりすまし" });
      expect(error).not.toBeNull();
      // 相手の行が書き換わっていないこと
      const { data } = await other().from("profiles").select("display_name").eq("id", otherId()).single();
      expect(data?.display_name).not.toBe("なりすまし");
    });

    it("作成：誰でもない id でも作れない（RLS 違反）", async () => {
      const { error } = await me().from("profiles").insert({ id: crypto.randomUUID(), display_name: "x" });
      expect(error?.code).toBe(RLS_VIOLATION);
    });

    it("更新：相手の行は更新できない（0件）", async () => {
      const { data, error } = await me()
        .from("profiles")
        .update({ display_name: "書き換え" })
        .eq("id", otherId())
        .select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("profiles").select("display_name").eq("id", otherId()).single();
      expect(check?.display_name).not.toBe("書き換え");
    });

    it("更新：自分の行の id を相手の id へ書き換えられない", async () => {
      const { error } = await me().from("profiles").update({ id: otherId() }).eq("id", myId());
      expect(error).not.toBeNull();
      // 自分の行はそのまま
      const { data } = await me().from("profiles").select("id").eq("id", myId());
      expect(data).toEqual([{ id: myId() }]);
    });

    it("削除：相手の行は削除できない（0件）", async () => {
      const { data, error } = await me().from("profiles").delete().eq("id", otherId()).select("id");
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: check } = await other().from("profiles").select("id").eq("id", otherId());
      expect(check).toEqual([{ id: otherId() }]);
    });
  });
}

crossUserSuite("A → B", () => a, () => idA, () => b, () => idB);
crossUserSuite("B → A", () => b, () => idB, () => a, () => idA);

describe("未ログイン（anon）", () => {
  // anon にはテーブル権限そのものを与えていないため、
  // 「権限なしエラー(42501)」か「0件」のどちらかになれば拒否できている。
  it("読取：何も見えない", async () => {
    const { data, error } = await anon.from("profiles").select("id");
    expect(error?.code === RLS_VIOLATION || (error === null && data?.length === 0)).toBe(true);
  });

  it("作成：できない", async () => {
    const { error } = await anon.from("profiles").insert({ id: crypto.randomUUID(), display_name: "x" });
    expect(error).not.toBeNull();
  });

  it("更新・削除：できない", async () => {
    const { data: u, error: ue } = await anon.from("profiles").update({ display_name: "x" }).eq("id", idA).select("id");
    expect(ue !== null || u?.length === 0).toBe(true);
    const { data: d, error: de } = await anon.from("profiles").delete().eq("id", idA).select("id");
    expect(de !== null || d?.length === 0).toBe(true);

    // A の行は無傷
    const { data: check } = await a.from("profiles").select("id, display_name").eq("id", idA).single();
    expect(check?.id).toBe(idA);
    expect(check?.display_name).not.toBe("x");
  });
});

describe("正常系（テストが本当に効いているかの確認）", () => {
  it("自分の行は読める・更新できる", async () => {
    const { data, error } = await a
      .from("profiles")
      .update({ memo: "自分で書いたメモ" })
      .eq("id", idA)
      .select("id, memo");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: idA, memo: "自分で書いたメモ" }]);
  });
});

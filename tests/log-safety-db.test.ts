/**
 * ログの安全化のテスト（T3）：本物の DB のエラーで確かめる。
 *
 * 開発用 Supabase に架空の利用者でログインし、
 * **わざと DB の決まりに違反する書き込み**をする。
 *
 *   ① 返ってきたエラーを、以前のように丸ごとログへ出したときに何が出るかを記録する
 *   ② それをログの関数に通すと、目印が出ないこと
 *
 * 【2026-09-29 に開発用 Supabase で実際に確かめた結果】
 * ・DBの決まりの違反（23514）・空欄の禁止（23502）・重複（23505）では、
 *   Supabase は details を返さなかった（null）。失敗した行の値は入っていなかった
 * ・ただし番号の形の誤り（22P02）では、**入力した値そのものが message に入った**
 *   → 以前のように丸ごと出すと、その値がログに出る（こちらは危険が本物）
 * 返し方は Supabase 側の設定や版で変わりうるので、どの場合も
 * 「ログの関数を通せば出ない」ことを確かめる。
 *
 * 失敗する書き込みなので、DB には何も残らない
 * （確かめるために作る会話1件は、最後に消す）。
 * アプリと同じ公開用キーで接続する（秘密キーは使わない）。
 */
import { config as loadEnv } from "dotenv";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dbCode, logFailure } from "@/lib/log";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const CANARY = `CANARY-本文-${Math.random().toString(36).slice(2, 8)}`;

let a: SupabaseClient;
let idA: string;
let convA: string;
let msgA: string;

let printed: string[] = [];

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  if (!url || !anonKey || !pa) throw new Error(".env.test.local の設定が足りません");

  a = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await a.auth.signInWithPassword({ email: "kasshi-test-a@example.com", password: pa });
  if (error) throw new Error(`ログイン失敗: ${error.message}`);
  idA = data.user!.id;

  // 目印は入れない（ここは失敗させない書き込み）
  const { data: conv, error: e1 } = await a
    .from("conversations")
    .insert({ user_id: idA, title: "ログ安全化テスト" })
    .select("id")
    .single();
  if (e1) throw new Error(`会話の作成に失敗: ${e1.code}`);
  convA = conv.id;

  const { data: msg, error: e2 } = await a
    .from("messages")
    .insert({ conversation_id: convA, user_id: idA, role: "user", content: "ログ安全化テストの発言" })
    .select("id")
    .single();
  if (e2) throw new Error(`発言の作成に失敗: ${e2.code}`);
  msgA = msg.id;
});

afterAll(async () => {
  if (convA) await a.from("conversations").delete().eq("id", convA);
});

beforeEach(() => {
  printed = [];
  const keep = (...args: unknown[]) => {
    printed.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" "));
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation(keep);
  }
});

afterEach(() => {
  // どのテストでも、ログに目印が出ていないこと
  expect(printed.join("\n")).not.toContain("CANARY");
  vi.restoreAllMocks();
});

describe("T3 本物の DB のエラーでも、本文はログに出ない", () => {
  it("本人の発言の保存：DBの決まりに違反させても、ログには番号だけ", async () => {
    const { error } = await a.from("messages").insert({
      conversation_id: convA,
      user_id: idA,
      role: "not-a-role", // 決まり（user / assistant）に違反させる
      content: `本人の発言 ${CANARY}`,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    // ① 本文が details / message / hint のどこかに入っていても、いなくても
    //    （この環境では details は null。結果は報告書に記録）

    // ② ログの関数を通すと出ない
    logFailure("send.save_user_message", { stage: "insert", kind: "db", code: dbCode(error) });
    expect(printed).toEqual([
      "[ai-kasshi] fail op=send.save_user_message stage=insert kind=db code=23514",
    ]);
  });

  it("記憶候補の保存：DBの決まりに違反させても、ログには番号だけ", async () => {
    const { error } = await a.from("memory_candidates").insert({
      user_id: idA,
      conversation_id: convA,
      source_message_id: msgA,
      candidate_index: 1,
      // 「残さない」は本文を持てない決まり（Phase 4A）に違反させる
      status: "rejected",
      suggested_text: `候補の本文 ${CANARY}`,
      extraction_reason: `AIの理由 ${CANARY}`,
      origin: "self_experience",
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");

    logFailure("candidate.save", { stage: "insert", kind: "db", code: dbCode(error) });
    expect(printed).toEqual(["[ai-kasshi] fail op=candidate.save stage=insert kind=db code=23514"]);
  });

  it("番号の形の誤り：入力した値が message に入る（丸ごと出すと漏れる）", async () => {
    const { error } = await a.rpc("delete_memory", { target: CANARY });

    // ① 危険が本物であること：生のエラーには、入力した値（目印）が入っている
    expect(error).not.toBeNull();
    expect(error!.code).toBe("22P02");
    expect(JSON.stringify(error)).toContain(CANARY);

    logFailure("memory.delete", { stage: "rpc", kind: "db", code: dbCode(error) });
    expect(printed).toEqual(["[ai-kasshi] fail op=memory.delete stage=rpc kind=db code=22P02"]);
  });

  it("失敗した書き込みは、DB に何も残していない", async () => {
    const { data: msgs } = await a.from("messages").select("content").eq("conversation_id", convA);
    const { data: cands } = await a.from("memory_candidates").select("id").eq("conversation_id", convA);
    expect((msgs ?? []).some((m) => String(m.content).includes("CANARY"))).toBe(false);
    expect(cands ?? []).toHaveLength(0);
  });
});

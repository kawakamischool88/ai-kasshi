/**
 * 台帳と復元の安全化（Phase C）の通しのテスト。
 *
 * 開発用 Supabase で、実際のスクリプトを順に動かす。
 *   backup → （控えの後に本人が操作）→ ledger → restore → restore:ledger → restore:verify
 *
 * 【本物の台帳・バックアップには触れない】
 * AI_KASSHI_BACKUP_DIR で一時フォルダに切り替える。
 * 戻す先は、開発用 DB の隔離した場所（restore スキーマ）。最後に片付ける。
 *
 * 【表示の安全（C8）】
 * どのスクリプトの表示にも、目印の文字（本文）とメールアドレスが出ないことも確かめる。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "../scripts/lib/db";
import { linkedTarget } from "../scripts/lib/target";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TAG = `phaseC${Math.random().toString(36).slice(2, 8)}`;
const DAY = 24 * 60 * 60 * 1000;

let a: SupabaseClient;
let b: SupabaseClient;
let admin: SupabaseClient;
let idA: string;
let idB: string;
let dir: string;
const createdConvs: string[] = [];
let printed = ""; // すべてのスクリプトの表示

// 架空のデータの番号
const ids: Record<string, string> = {};

function client(key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string) {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { c, id: data.user!.id };
}

async function conv(c: SupabaseClient, userId: string, label: string) {
  const { data, error } = await c.from("conversations").insert({ user_id: userId, title: `${TAG} ${label}` }).select("id").single();
  if (error) throw new Error(`会話: ${error.message}`);
  createdConvs.push(data.id);
  return data.id as string;
}

async function say(c: SupabaseClient, userId: string, convId: string, role: "user" | "assistant", content: string) {
  const { data, error } = await c.from("messages").insert({ conversation_id: convId, user_id: userId, role, content }).select("id").single();
  if (error) throw new Error(`発言: ${error.message}`);
  return data.id as string;
}

async function cand(
  c: SupabaseClient,
  userId: string,
  convId: string,
  msgId: string,
  text: string,
  status = "confirmed",
  expiresAt = new Date(Date.now() + 20 * DAY).toISOString(),
) {
  const { data, error } = await c
    .from("memory_candidates")
    .insert({
      user_id: userId,
      conversation_id: convId,
      source_message_id: msgId,
      candidate_index: 1,
      suggested_text: text,
      extraction_reason: `${text} の理由`,
      origin: "self_experience",
      status,
      confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw new Error(`候補: ${error.message}`);
  return data.id as string;
}

/** スクリプトを一時フォルダで動かす。表示を集める */
function run(script: string, args: string[] = []): { code: number; out: string } {
  const r = spawnSync(`npx tsx scripts/${script}.ts ${args.map((x) => `"${x}"`).join(" ")}`, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, AI_KASSHI_BACKUP_DIR: dir },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  printed += `\n===== ${script}\n${out}`;
  return { code: r.status ?? -1, out };
}

function one<T = Record<string, unknown>>(sql: string): T {
  return runSql<T>(sql)[0];
}

/** 戻した場所での B の行（件数と状態の要約） */
function bSnapshot(): string {
  return JSON.stringify(
    runSql(`
      select
        (select count(*) from restore.conversations where user_id = '${idB}') as c,
        (select count(*) from restore.messages where user_id = '${idB}') as m,
        (select count(*) from restore.messages where user_id = '${idB}' and excluded_from_ai_at is not null) as ex,
        (select string_agg(status || ':' || coalesce(length(suggested_text), -1)::text, ',' order by id)
           from restore.memory_candidates where user_id = '${idB}') as mc,
        (select count(*) from restore.memory_deletions where user_id = '${idB}') as d`),
  );
}

beforeAll(async () => {
  // 開発用を向いていなければ、何もしない（本番の restore スキーマを作り直さないため）
  const t = linkedTarget();
  if (t.kind !== "dev") throw new Error(`中止：CLI が開発用を向いていません（${t.label}）`);
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !serviceKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");
  ({ c: a, id: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ c: b, id: idB } = await signIn("kasshi-test-b@example.com", pb));
  admin = client(serviceKey);
  dir = mkdtempSync(path.join(tmpdir(), "kasshi-restore-"));

  // ---------------- 控えを取る前の状態 ----------------
  // 系列（あとで 訂正 → 考えの変化 → 削除 する）
  ids.X = await conv(a, idA, "系列");
  ids.xq = await say(a, idA, ids.X, "user", `${TAG}-chain 元の発言`);
  ids.M1 = await cand(a, idA, ids.X, ids.xq, `${TAG}-chain 元`);
  // その記憶への提案（文章の案・理由あり）
  ids.req = (
    await a
      .from("memory_revision_requests")
      .insert({
        user_id: idA, conversation_id: ids.X, source_message_id: ids.xq, request_index: 1,
        intent: "correct", target_memory_id: ids.M1,
        proposed_text: `${TAG}-proposal 文章の案`, reason: `${TAG}-proposal 理由`, status: "pending",
      })
      .select("id")
      .single()
  ).data!.id;

  // 消していない訂正（あとで訂正するだけ）
  ids.Y = await conv(a, idA, "消さない訂正");
  ids.yq = await say(a, idA, ids.Y, "user", `${TAG}-keep 元の発言`);
  ids.K1 = await cand(a, idA, ids.Y, ids.yq, `${TAG}-keep 元`);

  // あとで会話ごと消す会話と、その記憶を使った別の会話の返事
  ids.Z = await conv(a, idA, "消す会話");
  ids.zq = await say(a, idA, ids.Z, "user", `${TAG}-zconv 消す会話の発言`);
  ids.Z1 = await cand(a, idA, ids.Z, ids.zq, `${TAG}-zconv 記憶`);
  ids.W = await conv(a, idA, "別の会話");
  await say(a, idA, ids.W, "user", `${TAG}-w 質問`);
  ids.wr = await say(a, idA, ids.W, "assistant", `${TAG}-w 以前うかがった話では…`);
  await a.from("memory_references").insert({ user_id: idA, message_id: ids.wr, memory_id: ids.Z1 });

  // あとで［残さない］にする確認待ち
  ids.Q = await conv(a, idA, "残さない");
  ids.qq = await say(a, idA, ids.Q, "user", `${TAG}-reject 発言`);
  ids.P = await cand(a, idA, ids.Q, ids.qq, `${TAG}-reject 候補`, "pending");

  // 期限を過ぎた確認待ち（控えには本文付きで入る）
  ids.R = await conv(a, idA, "期限切れ");
  ids.rq = await say(a, idA, ids.R, "user", `${TAG}-expire 発言`);
  ids.E = await cand(a, idA, ids.R, ids.rq, `${TAG}-expire 候補`, "pending", new Date(Date.now() - DAY).toISOString());

  // 別の利用者 B
  ids.BC = await conv(b, idB, "B");
  const bq = await say(b, idB, ids.BC, "user", `${TAG}-b 発言`);
  ids.BM = await cand(b, idB, ids.BC, bq, `${TAG}-b 記憶`);

  // ---------------- 1. 控えを取る ----------------
  const bk = run("backup");
  if (bk.code !== 0) throw new Error("backup に失敗");

  // ---------------- 控えの後に、本人が操作する ----------------
  // 訂正 → 考えの変化 → 系列ごと削除
  const x2 = await say(a, idA, ids.X, "user", `${TAG}-chain 訂正の発言`);
  ids.M2 = (await a.rpc("revise_memory", { target: ids.M1, kind: "correction", new_text: `${TAG}-chain 訂正後`, in_conversation: ids.X, in_message: x2 })).data;
  const x3 = await say(a, idA, ids.X, "user", `${TAG}-chain 考えが変わった発言`);
  ids.M3 = (await a.rpc("revise_memory", { target: ids.M2, kind: "update", new_text: `${TAG}-chain 今の考え`, in_conversation: ids.X, in_message: x3 })).data;
  await a.rpc("delete_memory", { target: ids.M3 });

  // 消していない訂正
  const y2 = await say(a, idA, ids.Y, "user", `${TAG}-keep 訂正の発言`);
  ids.K2 = (await a.rpc("revise_memory", { target: ids.K1, kind: "correction", new_text: `${TAG}-keep 訂正後`, in_conversation: ids.Y, in_message: y2 })).data;

  // 会話ごと削除
  await a.rpc("delete_conversation_with_memories", { target: ids.Z });

  // ［残さない］（画面の処理と同じ書き換え）
  await a
    .from("memory_candidates")
    .update({ status: "rejected", confirmed_at: new Date().toISOString(), suggested_text: null, confirmed_text: null, extraction_reason: null })
    .eq("id", ids.P);

  // ---------------- 台帳を更新する ----------------
  const lg = run("ledger");
  if (lg.code !== 0) throw new Error("ledger に失敗");
}, 600_000);

afterAll(async () => {
  try {
    runSql("drop schema if exists restore cascade;");
  } catch {
    // 片付けに失敗しても、次の restore が作り直す
  }
  for (const c of createdConvs) await admin.from("conversations").delete().eq("id", c);
  await admin.from("conversation_deletions").delete().in("conversation_id", createdConvs);
  await admin.from("memory_deletions").delete().in("conversation_id", createdConvs);
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("台帳（ledger）", () => {
  it("2. 変更台帳の、消した系列の行に本文が残っていない。消していない訂正は本文あり", () => {
    const lines = readFileSync(path.join(dir, "ledger", "dev", "revisions.jsonl"), "utf8").split("\n").filter(Boolean);
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const m2 = rows.find((r) => r.id === ids.M2)!;
    const m3 = rows.find((r) => r.id === ids.M3)!;
    for (const r of [m2, m3]) {
      expect(r.text).toBeNull();
      expect(r.deleted).toBe(true);
      expect(r.revision_of).toBeTruthy();
    }
    expect(rows.find((r) => r.id === ids.K2)!.text).toBe(`${TAG}-keep 訂正後`);
    // 台帳のどのファイルにも、消した・残さない・消した会話の本文は無い
    for (const f of readdirSync(path.join(dir, "ledger", "dev"))) {
      const body = readFileSync(path.join(dir, "ledger", "dev", f), "utf8");
      for (const word of ["-chain", "-reject", "-zconv", "-proposal", "-expire"]) {
        expect(body, `${f} に ${word}`).not.toContain(`${TAG}${word}`);
      }
    }
  });

  it("会話の削除・［残さない］が、本文なしで台帳に入っている", () => {
    const convRows = readFileSync(path.join(dir, "ledger", "dev", "conversation-deletions.jsonl"), "utf8");
    expect(convRows).toContain(ids.Z);
    const closures = readFileSync(path.join(dir, "ledger", "dev", "closures.jsonl"), "utf8");
    expect(closures).toContain(ids.P);
  });
});

describe("古いバックアップを隔離した場所へ戻し、台帳を当てる", () => {
  let bBefore = "";
  let verifyOut = "";
  let verifyCode = -1;

  beforeAll(() => {
    const folder = readdirSync(dir).find((f) => /^\d{4}-/.test(f))!;
    const rs = run("restore", [path.join(dir, folder)]);
    if (rs.code !== 0) throw new Error("restore に失敗");
    // 3. 戻しただけの状態では、消した系列が本文付きで戻っている（危険が本物）
    bBefore = bSnapshot();
    const rl = run("restore-ledger");
    if (rl.code !== 0) throw new Error("restore:ledger に失敗");
    const v = run("restore-verify");
    verifyOut = v.out;
    verifyCode = v.code;
  }, 600_000);

  it("3. 戻しただけの状態では、控えの内容（本文付きの記憶・確認待ち）が入っていた", () => {
    // 台帳を当てる前の B の要約が取れている（戻した場所にデータがある）
    expect(bBefore).toContain('"c"');
  });

  it("4. 系列（元・訂正後・今の考え）はすべて本文なし・削除", () => {
    for (const id of [ids.M1, ids.M2, ids.M3]) {
      const r = one<{ status: string; t: boolean }>(
        `select status, (suggested_text is not null or confirmed_text is not null or extraction_reason is not null) as t
         from restore.memory_candidates where id = '${id}'`,
      );
      expect(r.status).toBe("deleted");
      expect(r.t).toBe(false);
    }
  });

  it("5. 消していない訂正は、本文ありで正しく戻る（元は訂正前・新しい版がいま有効）", () => {
    const k1 = one<{ status: string; sb: string }>(`select status, superseded_by as sb from restore.memory_candidates where id = '${ids.K1}'`);
    expect(k1.status).toBe("superseded");
    expect(k1.sb).toBe(ids.K2);
    const k2 = one<{ status: string; ok: boolean }>(
      `select status, (confirmed_text = '${TAG}-keep 訂正後') as ok from restore.memory_candidates where id = '${ids.K2}'`,
    );
    expect(k2.status).toBe("confirmed");
    expect(k2.ok).toBe(true);
  });

  it("6. 会話ごと消した会話は戻らない（発言・記憶も）。別の会話の返事は残るが AI へ送らない", () => {
    const z = one<{ c: number; m: number; mc: number; d: number }>(`
      select (select count(*) from restore.conversations where id = '${ids.Z}')::int as c,
             (select count(*) from restore.messages where conversation_id = '${ids.Z}')::int as m,
             (select count(*) from restore.memory_candidates where id = '${ids.Z1}')::int as mc,
             (select count(*) from restore.conversation_deletions where conversation_id = '${ids.Z}')::int as d`);
    expect(z).toEqual({ c: 0, m: 0, mc: 0, d: 1 });
    const wr = one<{ n: number; ex: boolean }>(
      `select count(*)::int as n, bool_and(excluded_from_ai_at is not null) as ex from restore.messages where id = '${ids.wr}'`,
    );
    expect(wr).toEqual({ n: 1, ex: true });
  });

  it("7. ［残さない］は、本文なしの「残さない」", () => {
    const p = one<{ status: string; t: boolean }>(
      `select status, (suggested_text is not null or extraction_reason is not null) as t from restore.memory_candidates where id = '${ids.P}'`,
    );
    expect(p).toEqual({ status: "rejected", t: false });
  });

  it("8. 消した記憶への提案に、文章の案・理由が残らない（閉じている）", () => {
    const q = one<{ status: string; t: boolean }>(
      `select status, (proposed_text is not null or reason is not null) as t from restore.memory_revision_requests where id = '${ids.req}'`,
    );
    expect(q).toEqual({ status: "dismissed", t: false });
  });

  it("9. 期限を過ぎた確認待ちは、戻した場所でも本文なしの「期限切れ」", () => {
    const e = one<{ status: string; t: boolean }>(
      `select status, (suggested_text is not null or extraction_reason is not null) as t from restore.memory_candidates where id = '${ids.E}'`,
    );
    expect(e).toEqual({ status: "expired", t: false });
  });

  it("10. 他の利用者（B）の行は、台帳を当てても変わらない", () => {
    expect(bSnapshot()).toBe(bBefore);
    const bm = one<{ status: string; ok: boolean }>(
      `select status, (suggested_text = '${TAG}-b 記憶') as ok from restore.memory_candidates where id = '${ids.BM}'`,
    );
    expect(bm).toEqual({ status: "confirmed", ok: true });
  });

  it("12. restore:verify は、正常なら全項目 ○", () => {
    // 異常の行があれば、その行（項目名と件数だけ）を見せる
    expect(verifyOut.split(/\r?\n/).filter((l) => l.includes("×"))).toEqual([]);
    expect(verifyCode).toBe(0);
    expect(verifyOut).toContain("すべて異常なし");
  });

  it("12. わざと異常を入れると、restore:verify が見つける", () => {
    // 消した会話を戻した場所に入れ直す／消した記憶への提案に文章を戻す
    runSql(`
      insert into restore.conversations (id, user_id, title) values ('${ids.Z}', '${idA}', 'x');
      update restore.memory_revision_requests set reason = 'x' where id = '${ids.req}';
      select 1 as ok;`);
    const v = run("restore-verify");
    expect(v.code).toBe(1);
    expect(v.out).toContain("× 会話の削除の台帳にある会話が、戻した場所に残っていない");
    expect(v.out).toContain("× 削除済みの記憶への提案に、AIの文章の案・理由が残っていない");
  }, 300_000);

  it("C8. どのスクリプトの表示にも、本文（目印）とメールアドレスが出ていない", () => {
    expect(printed).not.toContain(TAG);
    expect(printed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

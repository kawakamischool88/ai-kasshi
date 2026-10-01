/**
 * 本番復旧の予行演習（Phase E ／ K2）。**開発用 DB の public** を、本番と同じ道で当て直す。
 *
 * ふだんのテストでは動かさない（開発用の public 全体に台帳を当てるため）。
 * 動かすとき： AI_KASSHI_REHEARSAL=1 npx vitest run tests/recover-rehearsal.test.ts
 *
 * 【流れ】
 *   1. 架空の利用者 G（残る人）・H（あとで完全削除したことにする人）を作る
 *   2. 実行前の控えを取る（台帳も一緒に。一時フォルダ）＝「物理バックアップの時点」
 *   3. その後に G が操作する：記憶を消す・会話ごと消す・［残さない］／ H を完全削除の台帳に書く
 *   4. 台帳を更新する
 *   5. 「物理バックアップから戻した」状態をまねる：G の行を、2 の控えの内容に戻す
 *   6. 本番と同じ守りを通して、開発用の public へ当て直す（予行演習のモード）→ 点検まで
 *   7. G の判断が戻り、H は消え、ほかの架空の利用者は件数が変わらないことを確かめる
 *   8. 後片付け（G・H を消す・一時フォルダを消す）
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { linkedTarget } from "../scripts/lib/target";

loadEnv({ path: ".env.test.local", override: true });

const ON = process.env.AI_KASSHI_REHEARSAL === "1";
const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TAG = `rehearsal${Math.random().toString(36).slice(2, 8)}`;
const TABLES = ["conversations", "messages", "memory_candidates", "memory_references", "memory_revision_requests", "memory_deletions", "conversation_deletions", "ai_usage"];

let admin: SupabaseClient;
let dir = "";
let printed = "";
const ids: Record<string, string> = {};
const people: Record<"G" | "H", { id: string; email: string; c: SupabaseClient }> = {} as never;
let othersBefore = "";
let restoredTo = "";

function client(key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(`npx tsx scripts/${script}.ts ${args.map((x) => `"${x}"`).join(" ")}`, {
    shell: true, encoding: "utf8", env: { ...process.env, AI_KASSHI_BACKUP_DIR: dir, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  printed += `\n===== ${script}\n${out}`;
  return { code: r.status ?? -1, out };
}

async function makePerson(key: "G" | "H") {
  const email = `kasshi-test-${key.toLowerCase()}-${TAG}@example.com`;
  const password = `pw-${TAG}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  const c = client(anonKey);
  await c.auth.signInWithPassword({ email, password });
  people[key] = { id: data.user.id, email, c };
}

/** 架空の利用者以外（テスト用の A・B など）の、表ごとの件数 */
async function othersCounts(): Promise<string> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count } = await admin
      .from(t)
      .select("*", { count: "exact", head: true })
      .not("user_id", "in", `(${people.G.id},${people.H.id})`);
    out[t] = count ?? -1;
  }
  return JSON.stringify(out);
}

/** 控え（jsonl）から、その人の行だけを読む（テストの中だけで使う。画面には出さない） */
function rowsOf(folder: string, table: string, userId: string): Record<string, unknown>[] {
  const text = readFileSync(path.join(dir, folder, `${table}.jsonl`), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.user_id === userId);
}

describe.skipIf(!ON)("本番復旧の予行演習（開発用の public）", () => {
  beforeAll(async () => {
    const t = linkedTarget();
    if (t.kind !== "dev") throw new Error(`中止：CLI が開発用を向いていません（${t.label}）`);
    admin = client(serviceKey);
    dir = mkdtempSync(path.join(tmpdir(), "kasshi-rehearsal-"));

    await makePerson("G");
    await makePerson("H");
    const G = people.G;
    const conv = async (c: SupabaseClient, uid: string, title: string) =>
      (await c.from("conversations").insert({ user_id: uid, title: `${TAG} ${title}` }).select("id").single()).data!.id as string;
    const say = async (c: SupabaseClient, uid: string, cv: string, role: string, text: string) =>
      (await c.from("messages").insert({ conversation_id: cv, user_id: uid, role, content: `${TAG} ${text}` }).select("id").single()).data!.id as string;
    const mem = async (c: SupabaseClient, uid: string, cv: string, m: string, text: string, status = "confirmed") =>
      (await c.from("memory_candidates").insert({
        user_id: uid, conversation_id: cv, source_message_id: m, candidate_index: 1, suggested_text: `${TAG} ${text}`,
        extraction_reason: `${TAG} 理由`, origin: "self_experience", status,
        confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
      }).select("id").single()).data!.id as string;

    ids.X = await conv(G.c, G.id, "記憶を消す会話");
    const xq = await say(G.c, G.id, ids.X, "user", "発言");
    ids.M1 = await mem(G.c, G.id, ids.X, xq, "消す記憶");
    ids.Y = await conv(G.c, G.id, "記憶を使った会話");
    await say(G.c, G.id, ids.Y, "user", "質問");
    ids.yr = await say(G.c, G.id, ids.Y, "assistant", "以前うかがった話では");
    await G.c.from("memory_references").insert({ user_id: G.id, message_id: ids.yr, memory_id: ids.M1 });
    ids.Q = await conv(G.c, G.id, "残さない");
    const qq = await say(G.c, G.id, ids.Q, "user", "残さない発言");
    ids.P = await mem(G.c, G.id, ids.Q, qq, "残さない候補", "pending");
    ids.Z = await conv(G.c, G.id, "会話ごと消す");
    await say(G.c, G.id, ids.Z, "user", "消す会話の発言");
    const H = people.H;
    const hc = await conv(H.c, H.id, "H の会話");
    await say(H.c, H.id, hc, "user", "H の発言");

    // 2. 実行前の控え（＝物理バックアップの時点）
    // 「物理バックアップで戻した時点」＝この控えを取った時点（本番でも、戻した時点は台帳の更新より前になる）
    restoredTo = new Date().toISOString();
    const bk = run("backup");
    if (bk.code !== 0) throw new Error("backup に失敗");

    // 3. そのあとに G が操作する / H を完全削除したことにする
    await G.c.rpc("delete_memory", { target: ids.M1 });
    await G.c.rpc("delete_conversation_with_memories", { target: ids.Z });
    await G.c.from("memory_candidates").update({ status: "rejected", confirmed_at: new Date().toISOString(), suggested_text: null, confirmed_text: null, extraction_reason: null }).eq("id", ids.P);
    appendFileSync(
      path.join(dir, "ledger", "dev", "account-deletions.jsonl"),
      JSON.stringify({ user_id: H.id, deleted_at: new Date().toISOString(), ledgerVersion: 2, recordedAt: new Date().toISOString() }) + "\n",
    );

    // 4. 台帳を更新
    if (run("ledger").code !== 0) throw new Error("ledger に失敗");

    // 5. 物理バックアップから戻した状態をまねる：G の行を、控えの時点に戻す
    const folder = readdirSync(dir).find((f) => /^\d{4}-/.test(f))!;
    for (const t of ["memory_deletions", "conversation_deletions", "memory_references", "memory_revision_requests", "memory_candidates", "messages", "conversations", "ai_usage"]) {
      await admin.from(t).delete().eq("user_id", G.id);
    }
    for (const t of ["conversations", "messages", "memory_candidates", "memory_references", "memory_revision_requests", "memory_deletions", "conversation_deletions"]) {
      const rows = rowsOf(folder, t, G.id);
      if (rows.length) {
        const { error } = await admin.from(t).insert(rows);
        if (error) throw new Error(`戻すまね（${t}）に失敗: ${error.code}`);
      }
    }
    othersBefore = await othersCounts();
  }, 900_000);

  afterAll(async () => {
    // 報告用に、件数と ○ × の行だけを書き出す（本文・メールアドレスは表示に出ないことを最後のテストで確かめている）
    const out = process.env.AI_KASSHI_REHEARSAL_SUMMARY;
    if (out) {
      const lines = printed.split(/\r?\n/).filter((l) => /=====|件|○|×|△|当てる先|予行演習/.test(l));
      writeFileSync(out, lines.join("\n"), "utf8");
    }
    for (const k of ["G", "H"] as const) {
      if (people[k]?.id) await admin.auth.admin.deleteUser(people[k].id).catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("戻したまねの状態では、G が消した記憶・会話・［残さない］が戻っている（危険が本物）", async () => {
    const { data: m } = await admin.from("memory_candidates").select("status").eq("id", ids.M1).single();
    expect(m?.status).toBe("confirmed");
    const { data: z } = await admin.from("conversations").select("id").eq("id", ids.Z);
    expect(z).toHaveLength(1);
    const { data: p } = await admin.from("memory_candidates").select("status").eq("id", ids.P).single();
    expect(p?.status).toBe("pending");
  });

  it("表示だけ：本番と同じ件数の表示。G と H の分が数えられる", () => {
    const r = run("recover-ledger", ["--restored-to", restoredTo], { AI_KASSHI_RECOVER_SIMULATE: "public" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("【予行演習・開発用の public へ】");
    expect(r.out).toContain("当てる先：public");
    expect(r.out).toMatch(/完全に消した利用者で戻っている人：[1-9]/);
    expect(r.out).toMatch(/消したのに削除になっていない記憶：[1-9]/);
    expect(r.out).toMatch(/消したのに戻っている会話：[1-9]/);
    expect(r.out).toMatch(/残さないと決めたのに確認待ちの候補：[1-9]/);
  }, 300_000);

  it("実行：当て直して点検まで通る。G の判断が戻り、H はログイン情報ごと消え、ほかの人は変わらない", async () => {
    const r = run(
      "recover-ledger",
      ["--restored-to", restoredTo, "--yes", "--prod", "--confirm-project", "ai-kasshi-dev", "--app-stopped"],
      { AI_KASSHI_RECOVER_SIMULATE: "public" },
    );
    expect(r.out.split(/\r?\n/).filter((l) => l.includes("×"))).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ 当て直しと点検が終わりました");

    const { data: m } = await admin.from("memory_candidates").select("status, suggested_text, extraction_reason").eq("id", ids.M1).single();
    expect(m).toEqual({ status: "deleted", suggested_text: null, extraction_reason: null });
    const { data: yr } = await admin.from("messages").select("content, excluded_from_ai_at").eq("id", ids.yr).single();
    expect(yr?.content).toContain(TAG);
    expect(yr?.excluded_from_ai_at).toBeTruthy();
    const { data: z } = await admin.from("conversations").select("id").eq("id", ids.Z);
    expect(z).toEqual([]);
    const { data: p } = await admin.from("memory_candidates").select("status, suggested_text").eq("id", ids.P).single();
    expect(p).toEqual({ status: "rejected", suggested_text: null });

    const { data: hUser } = await admin.auth.admin.getUserById(people.H.id);
    expect(hUser?.user ?? null).toBeNull();
    for (const t of TABLES) {
      const { count } = await admin.from(t).select("*", { count: "exact", head: true }).eq("user_id", people.H.id);
      expect(count, t).toBe(0);
    }
    expect(await othersCounts()).toBe(othersBefore);
  }, 900_000);

  it("表示に本文・メールアドレスが出ていない", () => {
    expect(printed).not.toContain(TAG);
    expect(printed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

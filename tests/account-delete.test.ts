/**
 * アカウントの完全削除と、本番復旧の当て直し（模擬）の通しのテスト（Phase D）。
 *
 * 開発用 Supabase に、このテストのためだけの架空の利用者を作って確かめる。
 *   C … 完全削除する人
 *   D … 管理者（完全削除できないことを確かめる）
 *   E … 「控えのあとに完全削除した人」をまねる（本番復旧の当て直しで消えることを確かめる）
 * 本物の台帳・バックアップには触れない（AI_KASSHI_BACKUP_DIR で一時フォルダ）。
 * 本番には一切触れない（本番復旧は、開発用の隔離した場所への「模擬」で確かめる）。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

const TAG = `phaseD${Math.random().toString(36).slice(2, 8)}`;
const TABLES = [
  "conversations",
  "messages",
  "memory_candidates",
  "memory_references",
  "memory_revision_requests",
  "memory_deletions",
  "conversation_deletions",
  "ai_usage",
];

let admin: SupabaseClient;
let idA: string;
let idB: string;
let dir: string;
let printed = "";
const people: Record<"C" | "D" | "E", { id: string; email: string; client?: SupabaseClient }> = {} as never;
let beforeAB = "";
let backupFolder = "";
let backupCreatedAt = "";

function client(key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string) {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗: ${error.message}`);
  return { c, id: data.user!.id };
}

async function makePerson(key: "C" | "D" | "E") {
  const email = `kasshi-test-${key.toLowerCase()}-${TAG}@example.com`;
  const password = `pw-${TAG}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`利用者の作成に失敗: ${error.message}`);
  const { c } = await signIn(email, password);
  people[key] = { id: data.user.id, email, client: c };
}

/** その人の画面の操作で、会話・記憶・出典・提案・削除の記録・［残さない］・訂正・原価を作る */
async function fill(c: SupabaseClient, userId: string, label: string) {
  const conv = async (t: string) => (await c.from("conversations").insert({ user_id: userId, title: `${TAG} ${t}` }).select("id").single()).data!.id as string;
  const say = async (cv: string, role: string, text: string) =>
    (await c.from("messages").insert({ conversation_id: cv, user_id: userId, role, content: `${TAG}-${label} ${text}` }).select("id").single()).data!.id as string;
  const mem = async (cv: string, m: string, text: string, status = "confirmed") =>
    (await c.from("memory_candidates").insert({
      user_id: userId, conversation_id: cv, source_message_id: m, candidate_index: 1,
      suggested_text: `${TAG}-${label} ${text}`, extraction_reason: `${TAG}-${label} 理由`, origin: "self_experience",
      status, confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
    }).select("id").single()).data!.id as string;

  const X = await conv("会話");
  const q = await say(X, "user", "発言");
  const r = await say(X, "assistant", "返事");
  const m1 = await mem(X, q, "記憶");
  await c.from("memory_references").insert({ user_id: userId, message_id: r, memory_id: m1 });
  await c.from("memory_revision_requests").insert({
    user_id: userId, conversation_id: X, source_message_id: q, request_index: 1, intent: "correct",
    target_memory_id: m1, proposed_text: `${TAG}-${label} 案`, reason: `${TAG}-${label} 提案の理由`, status: "pending",
  });
  const q2 = await say(X, "user", "訂正の発言");
  await c.rpc("revise_memory", { target: m1, kind: "correction", new_text: `${TAG}-${label} 訂正後`, in_conversation: X, in_message: q2 });
  const q3 = await say(X, "user", "消す記憶の発言");
  const m3 = await mem(X, q3, "消す記憶");
  await c.rpc("delete_memory", { target: m3 });
  const q4 = await say(X, "user", "残さない発言");
  const m4 = await mem(X, q4, "残さない候補", "pending");
  await c.from("memory_candidates").update({ status: "rejected", confirmed_at: new Date().toISOString(), suggested_text: null, confirmed_text: null, extraction_reason: null }).eq("id", m4);
  const Z = await conv("消す会話");
  await say(Z, "user", "消す会話の発言");
  await c.rpc("delete_conversation_with_memories", { target: Z });
  await c.from("ai_usage").insert({
    user_id: userId, conversation_id: X, operation_type: "chat", provider: "anthropic", model: "claude-sonnet-5",
    estimated_cost: 0.001, pricing_version: "test", pricing_date: "2026-09-29", status: "success",
  });
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(`npx tsx scripts/${script}.ts ${args.map((x) => `"${x}"`).join(" ")}`, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, AI_KASSHI_BACKUP_DIR: dir, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  printed += `\n===== ${script}\n${out}`;
  return { code: r.status ?? -1, out };
}

/** A・B の行の件数（完全削除の前後で変わらないことを確かめる） */
async function countsAB(): Promise<string> {
  const out: Record<string, number> = {};
  for (const [who, id] of [["A", idA], ["B", idB]] as const) {
    for (const t of TABLES) {
      const { count } = await admin.from(t).select("*", { count: "exact", head: true }).eq("user_id", id);
      out[`${who}.${t}`] = count ?? -1;
    }
  }
  return JSON.stringify(out);
}

function countIn(schema: string, userId: string): number {
  const parts = [
    ...TABLES.map((t) => `(select count(*) from ${schema}.${t} where user_id = '${userId}')`),
    `(select count(*) from ${schema}.profiles where id = '${userId}')`,
  ];
  return Number(runSql<{ n: number }>(`select (${parts.join(" + ")})::int as n`)[0].n);
}

function ledgerRows(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(path.join(dir, "ledger", "dev", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

beforeAll(async () => {
  const t = linkedTarget();
  if (t.kind !== "dev") throw new Error(`中止：CLI が開発用を向いていません（${t.label}）`);
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !serviceKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");
  admin = client(serviceKey);
  ({ id: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ id: idB } = await signIn("kasshi-test-b@example.com", pb));
  dir = mkdtempSync(path.join(tmpdir(), "kasshi-account-"));

  await makePerson("C");
  await makePerson("D");
  await makePerson("E");
  await admin.from("profiles").update({ role: "admin" }).eq("id", people.D.id);
  await fill(people.C.client!, people.C.id, "C");
  await fill(people.E.client!, people.E.id, "E");

  // 控えを取る（台帳も一緒に作られる）
  const bk = run("backup");
  if (bk.code !== 0) throw new Error("backup に失敗");
  backupFolder = readdirSync(dir).find((f) => /^\d{4}-/.test(f))!;
  backupCreatedAt = JSON.parse(readFileSync(path.join(dir, backupFolder, "manifest.json"), "utf8")).createdAt;

  beforeAB = await countsAB();
}, 600_000);

afterAll(async () => {
  try {
    runSql("drop schema if exists restore cascade;");
  } catch {
    // 次の restore が作り直す
  }
  for (const k of ["C", "D", "E"] as const) {
    if (people[k]?.id) await admin.auth.admin.deleteUser(people[k].id).catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe("控え（backup）", () => {
  it("目録に向き先（開発用・名前）が入り、番号・URL・鍵は入っていない。台帳も一緒に作られた", () => {
    const text = readFileSync(path.join(dir, backupFolder, "manifest.json"), "utf8");
    const m = JSON.parse(text);
    expect(m.target).toEqual({ kind: "dev", name: "ai-kasshi-dev", place: expect.any(String) });
    expect(text).not.toMatch(/supabase\.co|https?:\/\/|sb_|eyJ/);
    expect(ledgerRows("deletions.jsonl").some((r) => r.user_id === people.C.id)).toBe(true);
  });
});

describe("完全削除（account:delete）", () => {
  it("表示だけ：1人・確認用の8文字・件数が出る。メールアドレスと本文は出ない。何も消さない", () => {
    const r = run("account-delete", [people.C.email]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("見つかった人数：1 人");
    expect(r.out).toContain(`確認用の番号（先頭8文字）：${people.C.id.slice(0, 8)}`);
    expect(r.out).toContain("public.memory_candidates");
    expect(r.out).toContain("表示だけで終わりました");
    expect(r.out).not.toContain(people.C.email);
    expect(r.out).not.toContain(TAG);
    expect(countIn("public", people.C.id)).toBeGreaterThan(0);
  }, 120_000);

  it("0人 → 止まる", () => {
    const r = run("account-delete", [`nobody-${TAG}@example.com`, "--yes", "--confirm", "00000000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("対象が見つかりません");
  }, 120_000);

  it("管理者 → 止まる（--yes と確認用の8文字があっても）", () => {
    const r = run("account-delete", [people.D.email, "--yes", "--confirm", people.D.id.slice(0, 8)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("管理者は完全削除できません");
    expect(countIn("public", people.D.id)).toBeGreaterThan(0);
  }, 120_000);

  it("確認用の8文字が無い・違う・開発用なのに --prod → 止まり、何も消さない", () => {
    for (const args of [
      [people.C.email, "--yes"],
      [people.C.email, "--yes", "--confirm", "ffffffff"],
      [people.C.email, "--yes", "--confirm", people.C.id.slice(0, 8), "--prod"],
    ]) {
      const r = run("account-delete", args);
      expect(r.code, args.join(" ")).toBe(1);
    }
    expect(countIn("public", people.C.id)).toBeGreaterThan(0);
    expect(ledgerRows("account-deletions.jsonl")).toEqual([]);
  }, 300_000);

  it("実行：C のひも付く行がすべての表で0件。A・B は変わらない。台帳は完全削除の1行だけが C を守る", async () => {
    const r = run("account-delete", [people.C.email, "--yes", "--confirm", people.C.id.slice(0, 8)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("その人にひも付く行（消したあと）：0 件");
    expect(r.out).toContain("ほかの利用者の件数が変わった表：0 表");
    expect(r.out).toContain("○ 完全削除が終わりました");
    expect(r.out).not.toContain(people.C.email);

    expect(countIn("public", people.C.id)).toBe(0);
    expect(Number(runSql<{ n: number }>(`select count(*)::int as n from auth.users where id = '${people.C.id}'`)[0].n)).toBe(0);
    expect(await countsAB()).toBe(beforeAB);

    // 完全削除の台帳：番号と日時だけ（メールアドレス・本文なし）
    const acc = ledgerRows("account-deletions.jsonl");
    expect(acc).toHaveLength(1);
    expect(Object.keys(acc[0]).sort()).toEqual(["deleted_at", "ledgerVersion", "recordedAt", "user_id"]);
    expect(acc[0].user_id).toBe(people.C.id);
    const accText = readFileSync(path.join(dir, "ledger", "dev", "account-deletions.jsonl"), "utf8");
    expect(accText).not.toContain("@");
    expect(accText).not.toContain(TAG);

    // ほかの台帳から、C の行は消えている（E の行は残る）
    for (const f of ["deletions.jsonl", "revisions.jsonl", "conversation-deletions.jsonl", "closures.jsonl"]) {
      expect(ledgerRows(f).some((x) => x.user_id === people.C.id), f).toBe(false);
    }
    expect(ledgerRows("deletions.jsonl").some((x) => x.user_id === people.E.id)).toBe(true);
  }, 300_000);

  it("account:verify-deleted：確認用の8文字で、すべての表が0件と出る", () => {
    const r = run("account-verify-deleted", [people.C.id.slice(0, 8)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("○ その人にひも付く行は、すべての表で0件です。");
    expect(r.out).not.toContain(people.C.email);
  }, 120_000);
});

describe("古い控えから戻しても、完全に消した C は戻らない", () => {
  it("restore → restore:ledger → restore:verify", () => {
    const rs = run("restore", [path.join(dir, backupFolder)]);
    expect(rs.code).toBe(0);
    expect(rs.out).toContain("完全に消した利用者（38日以内の台帳 1 人）の行は戻していません");
    expect(countIn("restore", people.C.id)).toBe(0);
    // 同じ控えにいる E・A・B は戻っている
    expect(countIn("restore", people.E.id)).toBeGreaterThan(0);

    const rl = run("restore-ledger");
    expect(rl.code).toBe(0);
    const v = run("restore-verify");
    expect(v.out.split(/\r?\n/).filter((l) => l.includes("×"))).toEqual([]);
    expect(v.code).toBe(0);
    expect(v.out).toContain("完全に消した利用者（38日以内の台帳）の行が、どの表にも残っていない");
  }, 600_000);
});

describe("本番復旧の当て直し（recover:ledger）の守り【模擬：開発用の restore へ。本番には触れない】", () => {
  const SIM = { AI_KASSHI_RECOVER_SIMULATE: "1" };

  it("模擬でなければ、開発用を向いているだけで止まる", () => {
    const r = run("recover-ledger", ["--restored-to", new Date().toISOString(), "--yes", "--prod", "--confirm-project", "ai-kasshi-dev", "--app-stopped"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("CLI が本番を向いていません");
  }, 120_000);

  it("戻した時点が無い・未来・8日より前 → 止まる", () => {
    expect(run("recover-ledger", [], SIM).code).toBe(1);
    expect(run("recover-ledger", ["--restored-to", new Date(Date.now() + 86400000).toISOString()], SIM).code).toBe(1);
    expect(run("recover-ledger", ["--restored-to", new Date(Date.now() - 9 * 86400000).toISOString()], SIM).code).toBe(1);
  }, 300_000);

  it("DB に「戻した時点より1時間以上あと」の記録がある（＝戻した直後ではない）→ 止まる", () => {
    const tooEarly = new Date(new Date(backupCreatedAt).getTime() - 2 * 3600000).toISOString();
    const r = run("recover-ledger", ["--restored-to", tooEarly], SIM);
    expect(r.code).toBe(1);
    expect(r.out).toContain("戻した直後ではない");
  }, 120_000);

  it("表示だけ：件数だけが出る。控えのあとに完全削除した E が「戻っている人」に数えられる", () => {
    // E を「控えのあとに完全に消した人」として、台帳に書く（E のデータは戻した場所に残っている）
    appendFileSync(
      path.join(dir, "ledger", "dev", "account-deletions.jsonl"),
      JSON.stringify({ user_id: people.E.id, deleted_at: new Date().toISOString(), ledgerVersion: 2, recordedAt: new Date().toISOString() }) + "\n",
    );
    const r = run("recover-ledger", ["--restored-to", backupCreatedAt], SIM);
    expect(r.code).toBe(0);
    expect(r.out).toContain("完全に消した利用者で戻っている人：1 件");
    expect(r.out).toContain("表示だけで終わりました");
    expect(countIn("restore", people.E.id)).toBeGreaterThan(0);
  }, 120_000);

  it("--prod・プロジェクト名・--app-stopped のどれかが欠けたら止まり、何も変えない", () => {
    const base = ["--restored-to", backupCreatedAt, "--yes"];
    const cases = [
      [...base, "--confirm-project", "ai-kasshi-dev", "--app-stopped"],
      [...base, "--prod", "--confirm-project", "ai-kasshi-prod", "--app-stopped"],
      [...base, "--prod", "--confirm-project", "ai-kasshi-dev"],
    ];
    for (const args of cases) {
      const r = run("recover-ledger", args, SIM);
      expect(r.code, args.join(" ")).toBe(1);
    }
    expect(countIn("restore", people.E.id)).toBeGreaterThan(0);
  }, 300_000);

  it("すべてそろえば当て直し、点検まで通る。E の行は消え、A・B・ほかは変わらない", () => {
    const beforeA = countIn("restore", idA);
    const r = run(
      "recover-ledger",
      ["--restored-to", backupCreatedAt, "--yes", "--prod", "--confirm-project", "ai-kasshi-dev", "--app-stopped"],
      SIM,
    );
    expect(r.out.split(/\r?\n/).filter((l) => l.includes("×"))).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("消し直した利用者（38日以内の台帳）：2 人");
    expect(r.out).toContain("○ 当て直しと点検が終わりました");
    expect(countIn("restore", people.E.id)).toBe(0);
    expect(countIn("restore", idA)).toBe(beforeA);
  }, 600_000);

  it("どの命令の表示にも、メールアドレスと本文が出ていない", () => {
    expect(printed).not.toContain(TAG);
    for (const k of ["C", "D", "E"] as const) expect(printed).not.toContain(people[k].email);
    expect(printed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

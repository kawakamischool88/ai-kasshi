/**
 * 利用の停止・再開のテスト（Phase E ／ E5「停止して残す」）。
 *
 * 開発用 Supabase に、このテストのためだけの架空の利用者を作って確かめる。
 *   F … 停止して、再開する人
 *   K … 管理者（停止できないことを確かめる）
 * 本番には一切触れない。
 */
import { spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runSql } from "../scripts/lib/db";
import { linkedTarget } from "../scripts/lib/target";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TAG = `phaseE${Math.random().toString(36).slice(2, 8)}`;

let admin: SupabaseClient;
let printed = "";
const people: Record<"F" | "K", { id: string; email: string; password: string }> = {} as never;
let shortF = "";
let otherCountsBefore = 0;

function client(key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function run(args: string[]) {
  const r = spawnSync(`npx tsx scripts/account-suspend.ts ${args.map((x) => `"${x}"`).join(" ")}`, {
    shell: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  printed += out;
  return { code: r.status ?? -1, out };
}

async function signIn(p: { email: string; password: string }) {
  return client(anonKey).auth.signInWithPassword({ email: p.email, password: p.password });
}

function sessionsOf(id: string): number {
  return runSql<{ n: number }>(`select count(*)::int as n from auth.sessions where user_id = '${id}'`)[0].n;
}

function othersCount(): number {
  return runSql<{ n: number }>(
    `select count(*)::int as n from public.messages where user_id not in ('${people.F.id}', '${people.K.id}')`,
  )[0].n;
}

beforeAll(async () => {
  const t = linkedTarget();
  if (t.kind !== "dev") throw new Error(`中止：CLI が開発用を向いていません（${t.label}）`);
  admin = client(serviceKey);
  for (const key of ["F", "K"] as const) {
    const email = `kasshi-test-${key.toLowerCase()}-${TAG}@example.com`;
    const password = `pw-${TAG}-${Math.random().toString(36).slice(2)}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    people[key] = { id: data.user.id, email, password };
  }
  await admin.from("profiles").update({ role: "admin" }).eq("id", people.K.id);
  shortF = people.F.id.slice(0, 8);

  // F の会話を1つ作る（停止してもデータが残ることを確かめる）
  const s = await signIn(people.F);
  const c = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${s.data.session!.access_token}` } },
  });
  const conv = (await c.from("conversations").insert({ user_id: people.F.id, title: `${TAG} 会話` }).select("id").single()).data!.id;
  await c.from("messages").insert({ conversation_id: conv, user_id: people.F.id, role: "user", content: `${TAG} 発言` });
  otherCountsBefore = othersCount();
}, 180_000);

afterAll(async () => {
  for (const k of ["F", "K"] as const) {
    if (people[k]?.id) await admin.auth.admin.deleteUser(people[k].id).catch(() => {});
  }
}, 120_000);

describe("利用の停止・再開（開発用 DB・架空の利用者）", () => {
  it("表示だけでは何も変えない", async () => {
    const r = run([people.F.email]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("見つかった人数：1 人");
    expect(r.out).toContain(`確認用の番号（先頭8文字）：${shortF}`);
    expect(r.out).toContain("いまの状態：利用中");
    expect(r.out).toContain("表示だけで終わりました");
    expect((await signIn(people.F)).error).toBeNull();
  }, 120_000);

  it("確認用の8文字が違うと止まる", () => {
    const r = run([people.F.email, "--yes", "--confirm", "00000000"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("確認用の8文字が一致しません");
  }, 120_000);

  it("開発用なのに --prod が付いていると止まる", () => {
    const r = run([people.F.email, "--yes", "--confirm", shortF, "--prod"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("開発用を向いているのに --prod");
  }, 120_000);

  it("管理者は停止できない", () => {
    const r = run([people.K.email, "--yes", "--confirm", people.K.id.slice(0, 8)]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("管理者です");
  }, 120_000);

  it("停止：ログインできなくなり、ログイン中の記録が消え、データは残る。ほかの人は変わらない", async () => {
    expect(sessionsOf(people.F.id)).toBeGreaterThan(0);
    const r = run([people.F.email, "--yes", "--confirm", shortF]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("変えたあとの状態：停止中 ／ ログイン中：0 件");

    const again = await signIn(people.F);
    expect(again.error).not.toBeNull();
    expect(again.error!.code ?? again.error!.message).toMatch(/banned/i);
    expect(sessionsOf(people.F.id)).toBe(0);

    const { count } = await admin.from("messages").select("*", { count: "exact", head: true }).eq("user_id", people.F.id);
    expect(count).toBe(1);
    const { count: convs } = await admin.from("conversations").select("*", { count: "exact", head: true }).eq("user_id", people.F.id);
    expect(convs).toBe(1);
    expect(othersCount()).toBe(otherCountsBefore);
  }, 180_000);

  it("停止中にもう一度表示すると「停止中」", () => {
    const r = run([people.F.email]);
    expect(r.out).toContain("いまの状態：停止中");
  }, 120_000);

  it("再開：ふだんどおりログインでき、データもそのまま", async () => {
    const r = run([people.F.email, "--resume", "--yes", "--confirm", shortF]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("変えたあとの状態：利用中");
    const s = await signIn(people.F);
    expect(s.error).toBeNull();
    const { count } = await admin.from("messages").select("*", { count: "exact", head: true }).eq("user_id", people.F.id);
    expect(count).toBe(1);
  }, 180_000);

  it("表示に本文・メールアドレスが出ていない", () => {
    expect(printed).not.toContain(TAG);
    expect(printed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

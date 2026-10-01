/**
 * 確認待ちの記憶候補の30日自動期限切れ（Phase B ／ G4）のテスト。
 *
 * 架空ユーザー A・B で、開発用 Supabase に接続して確かめる。
 * 期限処理の関数は画面から呼べない作りなので、運営用のキー（service_role）で呼ぶ
 * （本番では定期実行が DB の中で呼ぶ。service_role を使うのは scripts/ と tests/ だけ）。
 */
import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { judgeMaintenance, EXPIRE_JOB, HISTORY_JOB, type MaintenanceStatus } from "../scripts/lib/maintenance";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const TAG = `phaseB-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const later = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let a: SupabaseClient;
let b: SupabaseClient;
let admin: SupabaseClient;
let idA: string;
let idB: string;
const created: { c: SupabaseClient; id: string }[] = [];
let runsBefore = 0; // テストの前にあった実行記録の最大の番号

function client(key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string) {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`ログイン失敗 ${email}: ${error.message}`);
  return { c, id: data.user!.id };
}

/** 会話と本人の発言を1つ作り、そこから候補を1つ作る（状態・日時は好きに決める） */
async function candidate(
  c: SupabaseClient,
  userId: string,
  label: string,
  opts: { status: string; createdAt: string; expiresAt: string; withText?: boolean },
): Promise<{ id: string; conv: string; msg: string }> {
  const { data: conv, error: e1 } = await c
    .from("conversations")
    .insert({ user_id: userId, title: `${TAG} ${label}` })
    .select("id")
    .single();
  if (e1) throw new Error(`会話: ${e1.message}`);
  created.push({ c, id: conv.id });
  const { data: msg, error: e2 } = await c
    .from("messages")
    .insert({ conversation_id: conv.id, user_id: userId, role: "user", content: `${TAG} ${label}` })
    .select("id")
    .single();
  if (e2) throw new Error(`発言: ${e2.message}`);

  const withText = opts.withText ?? true;
  const { data, error } = await c
    .from("memory_candidates")
    .insert({
      user_id: userId,
      conversation_id: conv.id,
      source_message_id: msg.id,
      candidate_index: 1,
      suggested_text: withText ? `${TAG}-${label} 本文` : null,
      extraction_reason: withText ? `${TAG}-${label} 理由` : null,
      origin: "self_experience",
      status: opts.status,
      confirmed_at: opts.status === "confirmed" ? opts.createdAt : null,
      created_at: opts.createdAt,
      expires_at: opts.expiresAt,
    })
    .select("id")
    .single();
  if (error) throw new Error(`候補「${label}」: ${error.message}`);
  return { id: data.id as string, conv: conv.id as string, msg: msg.id as string };
}

async function row(id: string) {
  const { data } = await admin
    .from("memory_candidates")
    .select("status, suggested_text, confirmed_text, extraction_reason, origin, created_at, expires_at, source_message_id")
    .eq("id", id)
    .single();
  return data!;
}

async function runExpiry(): Promise<number> {
  const { data, error } = await admin.rpc("expire_pending_candidates");
  if (error) throw new Error(`期限処理: ${error.code}`);
  return data as number;
}

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  const pb = process.env.TEST_USER_B_PASSWORD;
  if (!url || !anonKey || !serviceKey || !pa || !pb) throw new Error(".env.test.local の設定が足りません");
  ({ c: a, id: idA } = await signIn("kasshi-test-a@example.com", pa));
  ({ c: b, id: idB } = await signIn("kasshi-test-b@example.com", pb));
  admin = client(serviceKey);

  const { data } = await admin.from("maintenance_runs").select("id").order("id", { ascending: false }).limit(1);
  runsBefore = Number(data?.[0]?.id ?? 0);
});

afterAll(async () => {
  for (const { id } of created) await admin.from("conversations").delete().eq("id", id);
  // テストで増えた実行記録を片付ける（本文なしの記録だが、点検の表示を紛らわしくしないため）
  await admin.from("maintenance_runs").delete().gt("id", runsBefore);
});

// =============================================================
// 期限処理の対象と、対象でないもの
// =============================================================
describe("期限処理：30日を過ぎた確認待ちだけを期限切れにする", () => {
  let oldA: string, freshA: string, oldB: string, freshB: string;
  let confirmedA: string, rejectedA: string, deletedA: string, supersededA: string, archivedA: string;
  let newVersion: string, newVersion2: string;
  let before: Awaited<ReturnType<typeof row>>;
  let n1 = 0;
  let n2 = 0;

  beforeAll(async () => {
    oldA = (await candidate(a, idA, "31日前の確認待ち", { status: "pending", createdAt: ago(31), expiresAt: ago(1) })).id;
    freshA = (await candidate(a, idA, "期限前の確認待ち", { status: "pending", createdAt: ago(29), expiresAt: later(1) })).id;
    // 期限の日時が過去でも、確認待ち以外は対象外
    confirmedA = (await candidate(a, idA, "残した記憶", { status: "confirmed", createdAt: ago(40), expiresAt: ago(10) })).id;
    rejectedA = (await candidate(a, idA, "残さない", { status: "rejected", createdAt: ago(40), expiresAt: ago(10), withText: false })).id;
    deletedA = (await candidate(a, idA, "削除済み", { status: "deleted", createdAt: ago(40), expiresAt: ago(10), withText: false })).id;

    // 訂正前・以前の考え（期限の日時は過去）
    const s = await candidate(a, idA, "訂正前", { status: "confirmed", createdAt: ago(40), expiresAt: ago(10) });
    const { data: v1 } = await a.rpc("revise_memory", {
      target: s.id, kind: "correction", new_text: `${TAG}-訂正後`, in_conversation: s.conv, in_message: s.msg,
    });
    supersededA = s.id;
    newVersion = v1 as string;
    const p = await candidate(a, idA, "以前の考え", { status: "confirmed", createdAt: ago(40), expiresAt: ago(10) });
    const { data: v2 } = await a.rpc("revise_memory", {
      target: p.id, kind: "update", new_text: `${TAG}-今の考え`, in_conversation: p.conv, in_message: p.msg,
    });
    archivedA = p.id;
    newVersion2 = v2 as string;

    // 別の利用者（B）
    oldB = (await candidate(b, idB, "Bの31日前の確認待ち", { status: "pending", createdAt: ago(31), expiresAt: ago(1) })).id;
    freshB = (await candidate(b, idB, "Bの期限前の確認待ち", { status: "pending", createdAt: ago(2), expiresAt: later(28) })).id;

    before = await row(oldA);
    // 本人（A・B）はログインしたまま何もしない。運営用のキーで、画面を通さずに動かす
    n1 = await runExpiry();
    n2 = await runExpiry();
  });

  it("1. 31日前の確認待ち → 期限切れ・本文なし・理由なし。番号・日時・由来などは残る", async () => {
    const r = await row(oldA);
    expect(r.status).toBe("expired");
    expect(r.suggested_text).toBeNull();
    expect(r.confirmed_text).toBeNull();
    expect(r.extraction_reason).toBeNull();
    expect(r.origin).toBe(before.origin);
    expect(r.created_at).toBe(before.created_at);
    expect(r.expires_at).toBe(before.expires_at);
    expect(r.source_message_id).toBe(before.source_message_id);
    expect(n1).toBeGreaterThanOrEqual(2); // A と B の分
  });

  it("2. 期限前の確認待ち → 変わらない（A・B とも）", async () => {
    for (const id of [freshA, freshB]) {
      const r = await row(id);
      expect(r.status).toBe("pending");
      expect(r.suggested_text).toContain(TAG);
      expect(r.extraction_reason).toContain(TAG);
    }
  });

  it("3. 残した記憶・残さない・削除済み・訂正前・以前の考え・新しい版 → 変わらない", async () => {
    expect((await row(confirmedA)).status).toBe("confirmed");
    expect((await row(confirmedA)).suggested_text).toContain(TAG);
    expect((await row(rejectedA)).status).toBe("rejected");
    expect((await row(deletedA)).status).toBe("deleted");
    expect((await row(supersededA)).status).toBe("superseded");
    expect((await row(supersededA)).suggested_text).toContain(TAG);
    expect((await row(archivedA)).status).toBe("archived");
    expect((await row(archivedA)).suggested_text).toContain(TAG);
    expect((await row(newVersion)).status).toBe("confirmed");
    expect((await row(newVersion2)).status).toBe("confirmed");
  });

  it("4. 続けて2回 → 2回目は0件で、壊れない", async () => {
    expect(n2).toBe(0);
    expect((await row(oldA)).status).toBe("expired");
  });

  it("5. 本人がログインしていなくても処理される（B の分も、B が何もしないまま期限切れ）", async () => {
    const r = await row(oldB);
    expect(r.status).toBe("expired");
    expect(r.suggested_text).toBeNull();
    expect(r.extraction_reason).toBeNull();
  });

  it("10. 他の利用者・他の状態には影響しない（B の期限前の候補・A の他の行は上で確認）", async () => {
    // B の期限前の候補は、本人の画面から見ても本文ありの確認待ち
    const { data } = await b.from("memory_candidates").select("status, suggested_text").eq("id", freshB).single();
    expect(data?.status).toBe("pending");
    expect(data?.suggested_text).toContain(TAG);
    // A から B の候補は見えない（期限処理が越境の道を作っていない）
    const { data: seen } = await a.from("memory_candidates").select("id").eq("id", freshB);
    expect(seen).toEqual([]);
  });
});

// =============================================================
// 画面からは呼べない
// =============================================================
describe("6. 本人・未ログインからは、期限処理も実行記録も触れない", () => {
  it("期限処理を呼べない", async () => {
    const { error: e1 } = await a.rpc("expire_pending_candidates");
    expect(e1?.code).toBe("42501");
    const { error: e2 } = await client(anonKey).rpc("expire_pending_candidates");
    expect(e2?.code).toBe("42501");
  });

  it("実行記録を読めない・書けない", async () => {
    const { data: seen, error: se } = await a.from("maintenance_runs").select("id");
    expect(se?.code === "42501" || (seen ?? []).length === 0).toBe(true);
    const { error: ins } = await a.from("maintenance_runs").insert({ job: "expire_candidates", affected: 999, ok: true });
    expect(ins?.code).toBe("42501");
    const { data: anonSeen } = await client(anonKey).from("maintenance_runs").select("id");
    expect(anonSeen ?? []).toEqual([]);
  });
});

// =============================================================
// 画面の予備の処理と同時に動いても安全
// =============================================================
describe("7. 定期実行と画面の予備の処理が同時に動いても安全", () => {
  it("5回くり返して同時に動かしても、エラーなく、1件がちょうど期限切れになる", async () => {
    for (let i = 0; i < 5; i++) {
      const c = await candidate(a, idA, `同時${i}`, { status: "pending", createdAt: ago(31), expiresAt: ago(1) });
      const screen = a
        .from("memory_candidates") // actions.ts の expireOldCandidates と同じ書き換え
        .update({ status: "expired", suggested_text: null, confirmed_text: null, extraction_reason: null })
        .eq("status", "pending")
        .lte("expires_at", new Date().toISOString())
        .select("id");
      const [s, cron] = await Promise.all([screen, admin.rpc("expire_pending_candidates")]);
      expect(s.error).toBeNull();
      expect(cron.error).toBeNull();
      expect(cron.data).toBeGreaterThanOrEqual(0); // -1（失敗）ではない

      const r = await row(c.id);
      expect(r.status).toBe("expired");
      expect(r.suggested_text).toBeNull();
    }
    // 同時に動いても、失敗の記録は残っていない
    const { data: failed } = await admin.from("maintenance_runs").select("id").gt("id", runsBefore).eq("ok", false);
    expect(failed).toEqual([]);
  });
});

// =============================================================
// 実行記録
// =============================================================
describe("8. 実行記録に本文・利用者や候補の番号が無い", () => {
  it("列は 番号・処理の名前・日時・件数・成否・エラーの番号 だけ", async () => {
    const { data } = await admin.from("maintenance_runs").select("*").gt("id", runsBefore).order("id");
    expect((data ?? []).length).toBeGreaterThan(0);
    for (const r of data ?? []) {
      expect(Object.keys(r).sort()).toEqual(["affected", "error_code", "id", "job", "ok", "ran_at"]);
      expect(r.job).toBe("expire_candidates");
      expect(typeof r.id).toBe("number"); // 番号は連番（利用者・候補の番号と取り違えない）
    }
    const all = JSON.stringify(data);
    expect(all).not.toMatch(UUID);
    expect(all).not.toContain(TAG);
    expect(all).not.toContain(idA);
    expect(all).not.toContain(idB);
  });

  it("90日より前の記録は、期限処理のたびに消える（89日前は残る）", async () => {
    const { data: rows, error } = await admin
      .from("maintenance_runs")
      .insert([
        { job: "expire_candidates", ran_at: ago(91), affected: 0, ok: true },
        { job: "expire_candidates", ran_at: ago(89), affected: 0, ok: true },
      ])
      .select("id, ran_at");
    expect(error).toBeNull();
    await runExpiry();
    const { data: left } = await admin.from("maintenance_runs").select("id").in("id", rows!.map((r) => r.id));
    expect((left ?? []).map((r) => r.id)).toEqual([rows![1].id]);
  });

  it("エラーの番号の欄には、5文字の番号以外は入らない", async () => {
    const { error } = await admin
      .from("maintenance_runs")
      .insert({ job: "expire_candidates", affected: 0, ok: false, error_code: `${TAG} 本文` });
    expect(error?.code).toBe("23514");
  });
});

// =============================================================
// 点検コマンド
// =============================================================
describe("9. 点検コマンドは、件数と日時だけを表示する", () => {
  it("開発用 DB を点検し、本文・番号・メールアドレスを出さない", () => {
    const out = execSync("npx tsx scripts/maintenance-check.ts", { encoding: "utf8" });
    expect(out).toContain("点検する DB：ai-kasshi-dev");
    expect(out).toContain(`定期実行「${EXPIRE_JOB}」：有効`);
    expect(out).toContain(`定期実行「${HISTORY_JOB}」：有効`);
    expect(out).toContain("最後に正常に動いた日時");
    expect(out).toContain("期限を1日以上過ぎているのに「確認待ち」のままの候補：0 件");
    expect(out).not.toMatch(UUID);
    expect(out).not.toContain("@");
    expect(out).not.toContain(TAG);
  }, 60_000);

  const now = new Date("2026-09-29T03:00:00Z");
  const jobs = [
    { name: EXPIRE_JOB, schedule: "15 18 * * *", active: true },
    { name: HISTORY_JOB, schedule: "30 18 * * *", active: true },
  ];
  const normal: MaintenanceStatus = {
    lastOk: { ranAt: "2026-09-28T18:15:01Z", affected: 2 },
    lastRun: { ranAt: "2026-09-28T18:15:01Z", ok: true, errorCode: null },
    overdue: 0,
    jobs,
    lastCron: { status: "succeeded", endTime: "2026-09-28T18:15:01Z" },
  };

  it("正常：異常なし。日時は日本時間、件数だけ", () => {
    const j = judgeMaintenance(normal, now);
    expect(j.level).toBe("ok");
    expect(j.lines.join("\n")).toContain("2026/9/29 3:15:01");
    expect(j.lines.join("\n")).toContain("期限切れにした件数 2 件");
  });

  it("異常を、本文なしで見分けられる", () => {
    const cases: [string, Partial<MaintenanceStatus>, string][] = [
      ["登録なし", { jobs: [jobs[1]] }, "登録されていません"],
      ["止まっている", { jobs: [{ ...jobs[0], active: false }, jobs[1]] }, "止まっています"],
      ["古い", { lastOk: { ranAt: "2026-09-27T12:00:00Z", affected: 0 } }, "36時間以上"],
      ["失敗", { lastRun: { ranAt: "2026-09-28T18:15:01Z", ok: false, errorCode: "40P01" } }, "40P01"],
      ["仕組みの失敗", { lastCron: { status: "failed", endTime: "2026-09-28T18:15:01Z" } }, "失敗になっています"],
      ["残っている", { overdue: 3 }, "3 件"],
    ];
    for (const [name, patch, expected] of cases) {
      const j = judgeMaintenance({ ...normal, ...patch }, now);
      expect(j.level, name).toBe("ng");
      expect(j.lines.join("\n"), name).toContain(expected);
    }
  });

  it("まだ一度も動いていない：注意。知らない形の値は表示しない", () => {
    const j = judgeMaintenance({ ...normal, lastOk: null, lastRun: null }, now);
    expect(j.level).toBe("warn");
    const odd = judgeMaintenance(
      { ...normal, jobs: [{ ...jobs[0], schedule: `${TAG}本文` }, jobs[1]] },
      now,
    );
    expect(odd.lines.join("\n")).not.toContain(TAG);
    const badCode = judgeMaintenance(
      { ...normal, lastRun: { ranAt: "2026-09-28T18:15:01Z", ok: false, errorCode: `${TAG}` } },
      now,
    );
    expect(badCode.lines.join("\n")).not.toContain(TAG);
  });
});

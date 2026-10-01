/**
 * 本番データの守りのテスト（Phase E ／ E2・E3・E4）。
 *
 *   1. 本番へ流す SQL の見張り（prodSqlViolation）：本文の列・行を丸ごと取り出す書き方を止め、件数は通す
 *   2. runSql：本番とみなす（AI_KASSHI_TREAT_AS_PROD=1）と、本文を読む問い合わせは**流す前に**止まり、
 *      件数だけの問い合わせは通る（実際に流す先は開発用 DB）
 *   3. ふだんの点検（maintenance:check）と、利用者ごとの件数は、本番とみなしても止まらない
 *   4. Claude Code の見張り（.claude/hooks/prod-guard.mjs）：止める・確かめる・通すの判断と、実際の動き
 *   5. 完全削除・利用停止の命令は、実在の人のメールアドレスを命令の後ろに書くと止まり、
 *      キーボードから入力できないとき（AIツールから動かされたとき）も止まる。どちらもアドレスを画面に出さない
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prodSqlViolation } from "../scripts/lib/prod-guard";
import { runSql } from "../scripts/lib/db";
import { allCountedTables, countsFor, sum } from "../scripts/lib/account";

type Decide = (command: string, opts?: { prodRef?: string | null; prodLinked?: boolean }) => { decision: string; reason?: string };
const HOOK = path.join(process.cwd(), ".claude", "hooks", "prod-guard.mjs");
const FAKE_REF = "abcdefghijklmnopqrst";

async function loadDecide(): Promise<Decide> {
  const mod = (await import(/* @vite-ignore */ `file:///${HOOK.replace(/\\/g, "/")}`)) as { decide: Decide };
  return mod.decide;
}

describe("1. 本番へ流す SQL の見張り", () => {
  it("件数・状態・日時だけの問い合わせは通す", () => {
    expect(prodSqlViolation("select count(*)::int as n from public.messages", "counts")).toBeNull();
    expect(prodSqlViolation("select status, count(*) from public.memory_candidates group by status", "counts")).toBeNull();
    expect(prodSqlViolation("select max(created_at) from public.ai_usage", "counts")).toBeNull();
    expect(prodSqlViolation("select count(*) from public.messages where excluded_from_ai_at is not null", "counts")).toBeNull();
  });

  it("本文・本人の情報の列を読む問い合わせは止める", () => {
    for (const sql of [
      "select content from public.messages",
      "select id, suggested_text from public.memory_candidates",
      "select title from public.conversations",
      "select email from auth.users",
      "select extraction_reason from public.memory_candidates",
      "select proposed_text, reason from public.memory_revision_requests",
      "select raw_user_meta_data from auth.users",
      "select m.CONTENT from public.messages m",
    ]) {
      expect(prodSqlViolation(sql, "counts"), sql).not.toBeNull();
    }
  });

  it("行を丸ごと取り出す書き方は止める（列の名前が無くても本文が出るため）", () => {
    for (const sql of [
      "select * from public.messages",
      "select to_jsonb(m) from public.messages m",
      "select row_to_json(c) from public.conversations c",
      "select json_agg(x) from public.memory_candidates x",
      "select jsonb_agg(m) from public.messages m",
      "select m.* from public.messages m",
    ]) {
      expect(prodSqlViolation(sql, "counts"), sql).not.toBeNull();
    }
  });

  it("コメントや文字列の中の言葉では止めない（列の名前だけを見る）", () => {
    expect(prodSqlViolation("-- content は読まない\nselect count(*) from public.messages", "counts")).toBeNull();
    expect(prodSqlViolation("select count(*) from public.memory_candidates where status = 'content'", "counts")).toBeNull();
    expect(prodSqlViolation("/* title */ select 1", "counts")).toBeNull();
  });

  it("理由の表示は列の名前だけで、SQL の中の値は出さない", () => {
    const why = prodSqlViolation("select content from public.messages where id = 'secret-value'", "counts")!;
    expect(why).toContain("content");
    expect(why).not.toContain("secret-value");
  });

  it("目的ごとに、決めた列だけを扱える", () => {
    expect(prodSqlViolation("select to_jsonb(t) from public.messages t", "backup")).toBeNull();
    expect(prodSqlViolation("select suggested_text, confirmed_text from public.memory_candidates", "ledger")).toBeNull();
    expect(prodSqlViolation("select content from public.messages", "ledger")).not.toBeNull();
    expect(prodSqlViolation("select id from auth.users where lower(email) = lower('x@example.com')", "account-lookup")).toBeNull();
    expect(prodSqlViolation("select title from public.conversations", "account-lookup")).not.toBeNull();
    expect(prodSqlViolation("update public.messages set content = null", "recover-apply")).toBeNull();
    expect(prodSqlViolation("select to_jsonb(m) from public.messages m", "recover-apply")).not.toBeNull();
    expect(prodSqlViolation("select email from auth.users", "recover-apply")).not.toBeNull();
  });
});

describe("2. runSql：本番とみなすと、本文を読む問い合わせは流す前に止まる", () => {
  afterEach(() => {
    delete process.env.AI_KASSHI_TREAT_AS_PROD;
  });

  it("本文の列を読む問い合わせは、流す前に止まる（無い表を指しても、DB のエラーではなく守りで止まる）", () => {
    process.env.AI_KASSHI_TREAT_AS_PROD = "1";
    expect(() => runSql("select content from public.no_such_table_phase_e")).toThrow(/中止：本番では、本文を読む問い合わせは流せません/);
    expect(() => runSql("select * from public.no_such_table_phase_e")).toThrow(/中止：本番では/);
    expect(() => runSql("select email from auth.users limit 1")).toThrow(/中止：本番では/);
  });

  it("件数だけの問い合わせは通る（開発用 DB で実際に流れる）", () => {
    process.env.AI_KASSHI_TREAT_AS_PROD = "1";
    const [row] = runSql<{ n: number }>("select count(*)::int as n from public.messages");
    expect(typeof row.n).toBe("number");
  }, 60_000);

  it("本番とみなさないとき（開発用）は、これまでどおり流れる", () => {
    const rows = runSql<{ n: number }>("select count(*)::int as n from (select content from public.messages limit 1) t");
    expect(rows).toHaveLength(1);
  }, 60_000);
});

describe("3. ふだんの点検と件数は、本番とみなしても止まらない", () => {
  afterEach(() => {
    delete process.env.AI_KASSHI_TREAT_AS_PROD;
  });

  it("利用者ごとの件数（完全削除の確かめで使う）は通る", () => {
    process.env.AI_KASSHI_TREAT_AS_PROD = "1";
    const counts = countsFor("00000000-0000-0000-0000-000000000000");
    expect(sum(counts)).toBe(0);
    expect(Object.keys(counts).length).toBe(allCountedTables().length);
  }, 120_000);

  it("maintenance:check は、本番とみなしても守りで止まらない", () => {
    const r = spawnSync("npx tsx scripts/maintenance-check.ts", {
      shell: true, encoding: "utf8", env: { ...process.env, AI_KASSHI_TREAT_AS_PROD: "1" }, maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).not.toContain("中止：本番では");
  }, 180_000);

  it("本番で本文を扱う命令は、最初に目的を名乗っている（名乗らない命令は、本番では件数しか読めない）", () => {
    const read = (f: string) => readFileSync(path.join("scripts", f), "utf8");
    expect(read("backup.ts")).toMatch(/setSqlPurpose\("backup"\)/);
    expect(read("ledger.ts")).toMatch(/setSqlPurpose\("ledger"\)/);
    expect(read("recover-ledger.ts")).toMatch(/setSqlPurpose\("recover-apply"\)/);
    expect(read("account-delete.ts")).toMatch(/setSqlPurpose\("account-lookup"\)/);
    expect(read("account-suspend.ts")).toMatch(/setSqlPurpose\("account-lookup"\)/);
    // 点検・件数の命令は名乗らない（＝件数だけ）
    expect(read("maintenance-check.ts")).not.toMatch(/setSqlPurpose/);
    expect(read("account-verify-deleted.ts")).not.toMatch(/setSqlPurpose/);
  });
});

describe("4. Claude Code の見張り（フック）", () => {
  it("いつでも止める命令", async () => {
    const decide = await loadDecide();
    for (const cmd of [
      "npm run account:delete -- --yes --confirm 12345678",
      "npx tsx scripts/account-delete.ts",
      "npm run account:suspend",
      "npm run account:verify-deleted -- 12345678",
      "npm run recover:ledger -- --restored-to 2026-09-29T00:00:00Z",
      "AI_KASSHI_SHOW_SQL_ERROR=1 npm run backup",
      "$env:AI_KASSHI_SHOW_SQL_ERROR='1'; npm run where",
      "npx supabase link --project-ref x",
      "npx vercel env pull .env.local",
    ]) {
      expect(decide(cmd, { prodRef: FAKE_REF, prodLinked: false }).decision, cmd).toBe("deny");
    }
  });

  it("本番のプロジェクト番号を名指しした DB の命令は止める", async () => {
    const decide = await loadDecide();
    expect(decide(`npx supabase db query --project-ref ${FAKE_REF} "select 1"`, { prodRef: FAKE_REF, prodLinked: false }).decision).toBe("deny");
    expect(decide(`psql postgres://x@db.${FAKE_REF}.supabase.co`, { prodRef: FAKE_REF, prodLinked: false }).decision).toBe("deny");
  });

  it("CLI が本番を向いているときは、DB を読む・書く命令を止め、点検は確かめる", async () => {
    const decide = await loadDecide();
    const prod = { prodRef: FAKE_REF, prodLinked: true };
    for (const cmd of [
      "npm run backup",
      "npm run ledger",
      "npm run restore -- backups/x",
      "npm run backup:cleanup",
      "npm run db:push",
      "npx supabase db query --linked \"select 1\"",
      "npx supabase migration list",
      "npx tsx scripts/where.ts",
      "node scripts/anything.mjs",
      "npm run admin -- x@example.com",
    ]) {
      expect(decide(cmd, prod).decision, cmd).toBe("deny");
    }
    expect(decide("npm run maintenance:check", prod).decision).toBe("ask");
  });

  it("CLI が開発用を向いているときの、ふだんの命令は通す", async () => {
    const decide = await loadDecide();
    const dev = { prodRef: FAKE_REF, prodLinked: false };
    for (const cmd of ["npm run backup", "npm run where", "npm run test", "npx tsc --noEmit", "npm run maintenance:check", "git status"]) {
      expect(decide(cmd, dev).decision, cmd).toBe("allow");
    }
  });

  it("Claude Code と同じ渡し方（標準入力の JSON）で、止める・確かめる・通すが動く", () => {
    const call = (command: string, env: Record<string, string> = {}) =>
      spawnSync("node", [HOOK], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
    const denied = call("npm run account:delete");
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain("止めました");

    const asked = call("npm run maintenance:check", { AI_KASSHI_HOOK_ASSUME_PROD: "1" });
    expect(asked.status).toBe(0);
    expect(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision).toBe("ask");

    const prodBackup = call("npm run backup", { AI_KASSHI_HOOK_ASSUME_PROD: "1" });
    expect(prodBackup.status).toBe(2);

    const allowed = call("npm run where");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe("");

    const broken = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
    expect(broken.status).toBe(0);
  });

  it("本番のプロジェクト番号を、見張りのファイルに書いていない（target.ts から読む）", () => {
    const text = readFileSync(HOOK, "utf8");
    const target = readFileSync(path.join("scripts", "lib", "target.ts"), "utf8");
    const ref = target.match(/ref:\s*"([a-z0-9]{20})",\s*name:\s*"ai-kasshi-prod"/)?.[1];
    expect(ref).toBeTruthy();
    expect(text).not.toContain(ref!);
  });

  it("設定ファイル（ai-kasshi・beyond-site）に、見張りと禁止の決まりが入っている", () => {
    const files = [path.join(".claude", "settings.json"), path.join("..", "beyond-site", ".claude", "settings.json")];
    for (const f of files) {
      const s = JSON.parse(readFileSync(f, "utf8"));
      const deny: string[] = s.permissions.deny;
      expect(deny.some((r) => r.startsWith("Bash(npm run account:delete"))).toBe(true);
      expect(deny.some((r) => r.startsWith("Bash(npm run recover:ledger"))).toBe(true);
      expect(deny.some((r) => r.includes("vercel env pull"))).toBe(true);
      expect(deny.some((r) => r.startsWith("Read(") && r.includes("backups/**"))).toBe(true);
      expect(deny.some((r) => r.startsWith("Read(") && r.includes(".env.local"))).toBe(true);
      expect(s.permissions.ask).toContain("mcp__terminal__read_terminal");
      const hook = s.hooks.PreToolUse[0];
      expect(hook.matcher).toBe("Bash|PowerShell");
      expect(hook.hooks[0].args[0]).toMatch(/prod-guard\.mjs$/);
    }
  });
});

describe("5. 完全削除・利用停止：メールアドレスの受け取り方", () => {
  const REAL_LIKE = "taro.yamada.phase-e@kasshi-guard.invalid";
  const run = (script: string, args: string[]) =>
    spawnSync(`npx tsx scripts/${script}.ts ${args.map((x) => `"${x}"`).join(" ")}`, {
      shell: true, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "",
    });

  for (const script of ["account-delete", "account-suspend"]) {
    it(`${script}：実在の人のようなアドレスを命令の後ろに書くと、DB を読む前に止まり、アドレスを出さない`, () => {
      const r = run(script, [REAL_LIKE]);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status).not.toBe(0);
      expect(out).toContain("実在の人のメールアドレスは、命令の後ろに書かないでください");
      expect(out).not.toContain("taro");
      expect(out).not.toContain("kasshi-guard");
      expect(out).not.toContain("見つかった人数");
    }, 120_000);

    it(`${script}：アドレスを書かず、キーボードから入力できないとき（AIツールから動かされたとき）は止まる`, () => {
      const r = run(script, []);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status).not.toBe(0);
      expect(out).toContain("運営者が自分の端末で実行してください");
      expect(out).not.toContain("見つかった人数");
    }, 120_000);
  }
});

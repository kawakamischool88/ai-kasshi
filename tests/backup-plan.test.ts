/**
 * migration を当てる前の DB でも、控えを安全に取れるか（Phase F）。DB にはつながない。
 *
 *   1. 控える表の決め方（planTables）：migration の状態だけで、外す表・止まる場合を決める
 *   2. 表を足した migration と、一覧（TABLE_INTRODUCED_BY）が食い違っていない
 *   3. 失敗の表示：Supabase CLI の「ERROR: 42P01: …」の形でも、5文字の番号だけを出す
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, TABLE_INTRODUCED_BY } from "../src/config/backup";
import { planTables } from "../scripts/lib/backup-plan";
import { safeErrorLine, sqlStateOf } from "../scripts/lib/safe-run";

const M1 = "20260929000001";
const M2 = "20260929000002";
const BASE = ["20260915000001", "20260924000001"];
const ALL_TABLES = [...BACKUP_TABLES];
const NEW_TABLES = ["conversation_deletions", "maintenance_runs"];
const OLD_TABLES = ALL_TABLES.filter((t) => !NEW_TABLES.includes(t));

describe("1. 控える表の決め方", () => {
  it("migration ①② が未適用（表も無い）→ 2表だけ外し、既存の8表は控える", () => {
    const plan = planTables(BASE, OLD_TABLES);
    expect(plan.include).toEqual(OLD_TABLES);
    expect(plan.include).toHaveLength(8);
    expect(plan.skipped.map((s) => [s.table, s.migration])).toEqual([
      ["conversation_deletions", M1],
      ["maintenance_runs", M2],
    ]);
    for (const s of plan.skipped) expect(s.reason).toContain("まだ DB に適用されていない");
  });

  it("migration ① だけ適用 → maintenance_runs だけ外す", () => {
    const plan = planTables([...BASE, M1], [...OLD_TABLES, "conversation_deletions"]);
    expect(plan.skipped.map((s) => s.table)).toEqual(["maintenance_runs"]);
    expect(plan.include).toHaveLength(9);
    expect(plan.include).toContain("conversation_deletions");
  });

  it("migration ①② が適用済み → 10表すべて控える（何もしなくても全部に戻る）", () => {
    const plan = planTables([...BASE, M1, M2], ALL_TABLES);
    expect(plan.include).toEqual(ALL_TABLES);
    expect(plan.skipped).toEqual([]);
  });

  it("migration が適用済みなのに、その表が無い → 止まる", () => {
    expect(() => planTables([...BASE, M1, M2], OLD_TABLES)).toThrow(/^中止：migration は適用済み.*conversation_deletions、maintenance_runs/);
    expect(() => planTables([...BASE, M1], OLD_TABLES)).toThrow(/中止：.*conversation_deletions/);
  });

  it("最初からある表が無い → 止まる（外してよいのは、あとから足した表だけ）", () => {
    const withoutMessages = ALL_TABLES.filter((t) => t !== "messages");
    expect(() => planTables([...BASE, M1, M2], withoutMessages)).toThrow(/中止：.*messages/);
    expect(() => planTables(BASE, OLD_TABLES.filter((t) => t !== "messages"))).toThrow(/中止：.*messages/);
  });

  it("migration が未適用なら、表が先にあっても外す（DB の migration の状態だけで決める）", () => {
    const plan = planTables(BASE, ALL_TABLES);
    expect(plan.skipped.map((s) => s.table)).toEqual(NEW_TABLES);
  });

  it("台帳用：conversation_deletions だけを見るときも同じ決まり", () => {
    expect(planTables(BASE, OLD_TABLES, ["conversation_deletions"]).skipped.map((s) => s.table)).toEqual(["conversation_deletions"]);
    expect(planTables([...BASE, M1], [...OLD_TABLES, "conversation_deletions"], ["conversation_deletions"]).include).toEqual([
      "conversation_deletions",
    ]);
    expect(() => planTables([...BASE, M1], OLD_TABLES, ["conversation_deletions"])).toThrow(/中止：/);
  });
});

describe("2. 表を足した migration と一覧が食い違っていない", () => {
  const dir = path.join("supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));

  it("一覧の migration は実在し、その中で初めてその表を作っている", () => {
    for (const [table, version] of Object.entries(TABLE_INTRODUCED_BY)) {
      const file = files.find((f) => f.startsWith(`${version}_`));
      expect(file, table).toBeTruthy();
      const re = new RegExp(`create table (if not exists )?public\\.${table}\\b`, "i");
      expect(readFileSync(path.join(dir, file!), "utf8"), table).toMatch(re);
      // それより前の migration では作っていない
      for (const f of files.filter((x) => x < file!)) {
        expect(readFileSync(path.join(dir, f), "utf8"), `${table} in ${f}`).not.toMatch(re);
      }
    }
  });

  it("控える表を作る migration は、一覧に載っているか、最初のころ（Phase A より前）のものだけ", () => {
    for (const table of BACKUP_TABLES) {
      const re = new RegExp(`create table (if not exists )?public\\.${table}\\b`, "i");
      const creator = files.find((f) => re.test(readFileSync(path.join(dir, f), "utf8")));
      expect(creator, table).toBeTruthy();
      if (creator! >= `${M1}_`) expect(TABLE_INTRODUCED_BY[table], table).toBe(creator!.slice(0, 14));
    }
  });
});

describe("3. 失敗の表示（エラーの番号だけ）", () => {
  const CANARY = "CANARY-本文-phaseF-7b3e";

  it("「ERROR: 42P01: …」の形から 42P01 だけを取り出す", () => {
    expect(sqlStateOf('ERROR:  42P01: relation "public.conversation_deletions" does not exist')).toBe("42P01");
    expect(sqlStateOf("failed to run sql: ERROR: 23514: new row violates check constraint")).toBe("23514");
    expect(sqlStateOf("ERROR: P0001: 自分で投げた例外")).toBe("P0001");
  });

  it("これまでの形も読める", () => {
    expect(sqlStateOf("ERROR: new row violates check constraint (SQLSTATE 23514)")).toBe("23514");
    expect(sqlStateOf('{"code":"22P02","message":"invalid input"}')).toBe("22P02");
  });

  it("形が違うものは「不明」のまま（番号でない語を番号と取り違えない）", () => {
    expect(sqlStateOf("ERROR: FATAL: something")).toBeNull();
    expect(sqlStateOf("ERROR: relation does not exist")).toBeNull();
    expect(sqlStateOf("ERROR: 42P0: 4文字")).toBeNull();
    expect(sqlStateOf("ERROR: 42p01: 小文字")).toBeNull();
    expect(sqlStateOf("何も無い")).toBeNull();
    expect(safeErrorLine(new Error("ERROR: FATAL: x"))).toContain("番号：不明");
  });

  it("表示は番号だけ。エラーの本文・SQL の本文・CANARY は出さない", () => {
    const e = new Error(
      `SQLの実行に失敗しました（終了コード 1）。\n  stderr：ERROR:  42P01: relation "public.conversation_deletions" does not exist\n` +
        `LINE 3: select '${CANARY}' as tbl, to_jsonb(x) from public.conversation_deletions x`,
    );
    const line = safeErrorLine(e);
    expect(line).toBe("SQL などの処理に失敗しました（DB のエラーの番号：42P01）。詳しい内容は表示しません。");
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain("conversation_deletions");
    expect(line).not.toContain("select");
  });

  it("本文の中に「ERROR: 12345:」が紛れていても、表示は5文字だけ", () => {
    const line = safeErrorLine(new Error(`Failing row contains (${CANARY} ERROR: 99999: ${CANARY})`));
    expect(line).not.toContain(CANARY);
    expect(line).toMatch(/番号：(99999|不明)）/);
  });
});

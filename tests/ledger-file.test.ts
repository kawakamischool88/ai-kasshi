/**
 * 台帳のファイルの扱い（Phase C ／ G2）と、表示の安全（C8）のテスト。
 * DB には触れない。一時フォルダだけを使う。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendNewRows,
  countTextInDeleted,
  readLedgerFile,
  rewriteLedgerSafely,
  scrubRevisionRows,
  type Row,
} from "../scripts/lib/ledger-file";
import { safeErrorLine, sqlStateOf } from "../scripts/lib/safe-run";
import { LEDGERS } from "../src/config/backup";

const CANARY = "CANARY-本文-ledger";

let dir: string;
let file: string;

const rows: Row[] = [
  { id: "m2", revision_of: "m1", revision_kind: "correction", version: 2, text: `${CANARY} 訂正後`, revised_at: "2026-09-29T01:00:00Z" },
  { id: "m3", revision_of: "m2", revision_kind: "update", version: 3, text: `${CANARY} 今の考え`, revised_at: "2026-09-29T02:00:00Z" },
  { id: "k2", revision_of: "k1", revision_kind: "correction", version: 2, text: "消していない訂正", revised_at: "2026-09-29T03:00:00Z" },
];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kasshi-ledger-"));
  file = path.join(dir, "revisions.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("G2 変更台帳から、消した系列の本文を消す", () => {
  const deleted = new Map<string, string | null>([
    ["m1", "2026-09-29T04:00:00Z"],
    ["m2", "2026-09-29T04:00:00Z"],
    ["m3", "2026-09-29T04:00:00Z"],
  ]);

  it("消した系列の行だけ本文を消し、番号・つながり・版・日時は残す", () => {
    const { rows: out, scrubbed } = scrubRevisionRows(rows, deleted);
    expect(scrubbed).toBe(2);
    const m2 = out.find((r) => r.id === "m2")!;
    expect(m2.text).toBeNull();
    expect(m2.deleted).toBe(true);
    expect(m2.deleted_at).toBe("2026-09-29T04:00:00Z");
    expect(m2.revision_of).toBe("m1");
    expect(m2.version).toBe(2);
    expect(m2.revised_at).toBe("2026-09-29T01:00:00Z");
    // 消していない訂正は本文ありのまま
    expect(out.find((r) => r.id === "k2")!.text).toBe("消していない訂正");
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("2回目は何も変えない", () => {
    const once = scrubRevisionRows(rows, deleted).rows;
    const twice = scrubRevisionRows(once, deleted);
    expect(twice.scrubbed).toBe(0);
    expect(twice.rows).toEqual(once);
  });

  it("消した系列に本文が残っている行を数える（「削除済み」の印・削除台帳のどちらでも）", () => {
    expect(countTextInDeleted(rows, deleted)).toBe(2);
    expect(countTextInDeleted([{ id: "x", deleted: true, text: CANARY }], new Map())).toBe(1);
    expect(countTextInDeleted(scrubRevisionRows(rows, deleted).rows, deleted)).toBe(0);
  });

  it("安全に書き直す：一時ファイル → 確かめる → 置き換える。一時ファイルは残らない", () => {
    const { rows: out } = scrubRevisionRows(rows, deleted);
    rewriteLedgerSafely(file, out, (reread) => {
      if (countTextInDeleted(reread, deleted) > 0) throw new Error("本文が残っている");
    });
    expect(readFileSync(file, "utf8")).not.toContain(CANARY);
    expect(readLedgerFile(file)).toHaveLength(3);
    expect(readdirSync(dir)).toEqual(["revisions.jsonl"]);
  });

  it("11. 途中で止まった（一時ファイルを書いた直後）→ 元の台帳は壊れず、一時ファイルも残らない", () => {
    const before = readFileSync(file, "utf8");
    const { rows: out } = scrubRevisionRows(rows, deleted);
    expect(() =>
      rewriteLedgerSafely(file, out, () => {}, {
        afterTempWrite: () => {
          throw new Error("電源が落ちたつもり");
        },
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["revisions.jsonl"]);
  });

  it("11. 確かめで問題が見つかった → 置き換えない", () => {
    const before = readFileSync(file, "utf8");
    expect(() =>
      rewriteLedgerSafely(file, rows, (reread) => {
        if (countTextInDeleted(reread, deleted) > 0) throw new Error("本文が残っている");
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["revisions.jsonl"]);
  });

  it("11. 一時ファイルが途中までしか書けていない（行数が合わない）→ 置き換えない", () => {
    const before = readFileSync(file, "utf8");
    expect(() =>
      rewriteLedgerSafely(file, rows, () => {}, {
        afterTempWrite: (temp) => writeFileSync(temp, JSON.stringify(rows[0]) + "\n", "utf8"),
      }),
    ).toThrow(/行数/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("壊れた行のある台帳は読まない（書き直さない）。エラーに中身を出さない", () => {
    writeFileSync(file, `${JSON.stringify(rows[0])}\n{壊れた行 ${CANARY}\n`, "utf8");
    let message = "";
    try {
      readLedgerFile(file);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("2 行目");
    expect(message).not.toContain(CANARY);
  });
});

describe("台帳は足していくだけ", () => {
  it("同じ鍵の行は二重に足さない", () => {
    const f = path.join(dir, "closures.jsonl");
    expect(appendNewRows(f, ["id"], [{ id: "a" }, { id: "b" }, { id: "a" }])).toBe(2);
    expect(appendNewRows(f, ["id"], [{ id: "a" }, { id: "c" }])).toBe(1);
    expect(readLedgerFile(f).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(existsSync(f)).toBe(true);
  });
});

describe("新しい台帳に、本文らしい欄がない", () => {
  it("会話の削除の台帳・［残さない］の台帳", () => {
    for (const fields of [LEDGERS.conversationDeletions.fields, LEDGERS.closures.fields]) {
      for (const f of fields) expect(f).not.toMatch(/text|content|body|suggested|reason|title|proposed|email/i);
    }
  });
});

describe("C8 失敗したときの表示に、本文を出さない", () => {
  it("DB のエラーの番号だけを取り出す", () => {
    expect(sqlStateOf('ERROR: new row violates check constraint (SQLSTATE 23514)')).toBe("23514");
    expect(sqlStateOf('{"code":"22P02","message":"invalid input"}')).toBe("22P02");
    expect(sqlStateOf("何も無い")).toBeNull();
  });

  it("本文を含むエラーでも、表示は番号だけ", () => {
    const e = new Error(
      `SQLの実行に失敗しました（終了コード 1）。\n  stderr：ERROR: 23514: Failing row contains (${CANARY}, a@b.jp) (SQLSTATE 23514)`,
    );
    const line = safeErrorLine(e);
    expect(line).toContain("23514");
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain("@");
  });
});

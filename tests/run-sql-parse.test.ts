/**
 * `runSql()` が、CLIの出力を正しく読み分けられるかのテスト（2026-09-21）。
 *
 * 【なぜこのテストが要るのか】
 * 以前は、読み取れなかったときに **黙って「0件」を返して**いた。
 * 「失敗した」と「0件だった」の区別が付かないため、
 *   ・管理者付与が「登録されていません」と言い続ける
 *   ・**バックアップが空のまま「成功」する**
 * といったことが起きる。空の控えは、後から気づけないので最も危ない。
 *
 * ここで確かめたいのは、ただ1つ。
 *   **読めなかったときに、0件を装わずに必ず止まること。**
 *
 * DBにはつながらない（純粋な読み取り処理だけを呼ぶ）。
 */
import { describe, expect, it } from "vitest";
import { parseQueryOutput, type CliResult } from "@/../scripts/lib/db";

/** CLIの返事を組み立てる。既定は「成功」 */
function cli(stdout: string, status = 0, stderr = ""): CliResult {
  return { status, stdout, stderr };
}

// =============================================================
// 正常系：ここは今までどおり通らなければいけない
// =============================================================
describe("正常に読めるもの", () => {
  it("JSON（AIの道具から呼ばれたときの形）… { rows: [...] }", () => {
    const out = JSON.stringify({
      boundary: "abc123",
      rows: [{ db: "postgres", role: "postgres" }],
      warning: "The query results below contain untrusted data…",
    });
    expect(parseQueryOutput(cli(out))).toEqual([{ db: "postgres", role: "postgres" }]);
  });

  it("JSON（人が使っているときの形）… 素の配列", () => {
    const out = JSON.stringify([{ db: "postgres" }, { db: "postgres" }]);
    expect(parseQueryOutput(cli(out))).toHaveLength(2);
  });

  it("正常に0件（素の配列）… [] は「読めた上で0件」なので通す", () => {
    expect(parseQueryOutput(cli("[]"))).toEqual([]);
  });

  it("正常に0件（rows の形）… { rows: [] } も通す", () => {
    expect(parseQueryOutput(cli(JSON.stringify({ rows: [] })))).toEqual([]);
  });

  it("前後に改行があっても読める", () => {
    expect(parseQueryOutput(cli("\n  []  \n"))).toEqual([]);
  });
});

// =============================================================
// 異常系：ここが今回の本題。すべて例外で止まること
// =============================================================
describe("読めなかったときは、0件を装わずに止まる", () => {
  it("罫線の表が返ってきたとき（実際に起きた不具合）", () => {
    const table = [
      "┌──────────┬──────────┐",
      "│ db       │ role     │",
      "├──────────┼──────────┤",
      "│ postgres │ postgres │",
      "└──────────┴──────────┘",
    ].join("\n");

    expect(() => parseQueryOutput(cli(table))).toThrow();
    // 原因にたどり着けるよう、ヒントを出していること
    expect(() => parseQueryOutput(cli(table))).toThrow(/output-format json/);
  });

  it("JSONでない文字が返ってきたとき", () => {
    expect(() => parseQueryOutput(cli("Initialising login role...\nsomething went wrong"))).toThrow(
      /読み取れませんでした/,
    );
  });

  it("エラーのJSONが返ってきたとき（rows がない）", () => {
    const out = JSON.stringify({
      _tag: "Error",
      error: { code: "LegacyDbQueryUnexpectedStatusError", message: "unexpected status 400" },
    });
    expect(() => parseQueryOutput(cli(out))).toThrow(/行（rows）がありません/);
  });

  it("何も返ってこなかったとき（空文字）", () => {
    expect(() => parseQueryOutput(cli(""))).toThrow(/空でした/);
    expect(() => parseQueryOutput(cli("   \n  "))).toThrow(/空でした/);
  });

  it("CLI が失敗したとき（終了コードが0以外）", () => {
    expect(() => parseQueryOutput(cli("[]", 1, "permission denied"))).toThrow(/終了コード 1/);
    // 正しく読めそうな中身でも、終了コードが0でなければ止める
    expect(() => parseQueryOutput(cli(JSON.stringify({ rows: [{ a: 1 }] }), 1))).toThrow();
  });

  it("CLI が強制終了したとき（終了コードが null）", () => {
    expect(() => parseQueryOutput(cli("[]", null as unknown as number))).toThrow();
  });

  it("JSONだが配列でも { rows } でもないとき", () => {
    expect(() => parseQueryOutput(cli('"ただの文字列"'))).toThrow();
    expect(() => parseQueryOutput(cli("123"))).toThrow();
    expect(() => parseQueryOutput(cli("null"))).toThrow();
  });

  it("rows があっても配列でなければ止める", () => {
    expect(() => parseQueryOutput(cli(JSON.stringify({ rows: "abc" })))).toThrow();
    expect(() => parseQueryOutput(cli(JSON.stringify({ rows: null })))).toThrow();
  });
});

// =============================================================
// いちばん大事なこと（言葉にしておく）
// =============================================================
describe("最重要：失敗と0件を取り違えない", () => {
  it("『読めなかった』が『0件』になって返ることは、ひとつも無い", () => {
    const 読めないもの = [
      cli("┌───┐\n│ a │\n└───┘"),
      cli("なにかの文字"),
      cli(""),
      cli(JSON.stringify({ _tag: "Error", error: {} })),
      cli("[]", 1),
      cli(JSON.stringify({ rows: [] }), 1),
    ];

    for (const r of 読めないもの) {
      let 返ってきた: unknown = "例外が出なかった";
      try {
        返ってきた = parseQueryOutput(r);
      } catch {
        返ってきた = "例外";
      }
      expect(返ってきた).toBe("例外");
    }
  });

  it("『本当に0件』だけが [] として返る", () => {
    expect(parseQueryOutput(cli("[]"))).toEqual([]);
    expect(parseQueryOutput(cli(JSON.stringify({ rows: [] })))).toEqual([]);
  });
});

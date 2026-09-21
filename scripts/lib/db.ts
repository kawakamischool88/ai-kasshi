/**
 * バックアップ・復元のスクリプトから、DBへSQLを流すための道具（Phase 4A）。
 *
 * 【なぜ普通の接続（supabase-js）を使わないか】
 * 復元先は「隔離した場所（別のスキーマ）」に作る。
 * その場所は、アプリのAPIからは**そもそも見えない**ようにしてある
 * （見えると隔離にならない）。そのため SQL で直接やりとりする。
 *
 * 【安全のため】
 * ここを使うのは scripts/ の中だけ。アプリ本体からは呼ばない。
 *
 * =============================================================
 * 【2026-09-21：ここで大きな事故が起きかけました】
 *
 * 以前のこの関数は、CLIの出力を読み取れなかったとき **黙って「0件」を返して**
 * いました。「失敗した」と「0件だった」の区別が付かない作りでした。
 *
 * 実際に起きたこと：
 *   Supabase CLI は、**人が使っているとき**は罫線の表を、
 *   **AIの道具から呼ばれたとき**は JSON を返す（`--agent` の自動判定）。
 *   川上さんの画面では表が返り、`{` が1つも無いため 0件扱いになり、
 *   「登録されていません」と出続けていた。
 *
 * これが**バックアップで起きていたら**、中身が空の控えが「成功」として
 * 作られ、目録の件数も0で整合するため、**後から気づけません**。
 *
 * そこで、
 *   ・出力形式を `--output-format json` で**明示**する（人でもAIでも同じ）
 *   ・読み取れなかったら**必ず例外で止まる**。0件を装わない
 * という作りに改めました。**この2つは絶対に外さないこと。**
 * =============================================================
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * CLI が返してくる形は2通りある（どちらも正常）。
 *
 *   ①（AIの道具から呼ばれたとき）
 *      { "boundary": "…", "rows": [ … ], "warning": "…" }
 *   ②（人が使っているとき）
 *      [ … ]                       ← 素の配列。0件なら []
 *
 * 失敗したときは、終了コードが 0 以外になるか、
 *   { "_tag": "Error", "error": { … } }
 * が返る。どちらも**行が無い**のであって「0件」ではない。
 */
export type CliResult = { status: number | null; stdout: string; stderr: string };

/** 罫線の表が返ってきたときに、原因が分かるようにするための目印 */
const BOX_CHARS = /[┌┬┐├┼┤└┴┘│─]/;

/**
 * CLI の出力から行を取り出す。**読めなければ例外を投げる。**
 *
 * この関数はDBにつながらない純粋な処理なので、テストから直接呼べる。
 */
export function parseQueryOutput<T = Record<string, unknown>>(r: CliResult): T[] {
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";

  // ---- 終了コード ----
  if (r.status !== 0) {
    throw new Error(
      `SQLの実行に失敗しました（終了コード ${r.status}）。\n` +
        `  stderr：${stderr.trim().slice(0, 500) || "（空）"}\n` +
        `  stdout：${stdout.trim().slice(0, 500) || "（空）"}`,
    );
  }

  // ---- そもそも何も返っていない ----
  if (stdout.trim() === "") {
    throw new Error(
      "SQLの結果が空でした（0件ではなく、何も返ってきていません）。\n" +
        `  stderr：${stderr.trim().slice(0, 500) || "（空）"}`,
    );
  }

  // ---- JSON として読む ----
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const hint = BOX_CHARS.test(stdout)
      ? "\n  ヒント：罫線の表が返っています。--output-format json が付いていない可能性があります。"
      : "";
    throw new Error(
      "SQLの結果をJSONとして読み取れませんでした。\n" +
        `  受け取った文字数：${stdout.length}\n` +
        `  先頭：${stdout.slice(0, 200)}${hint}`,
    );
  }

  // ---- 形① 素の配列（0件なら []） ----
  if (Array.isArray(parsed)) return parsed as T[];

  // ---- 形② { rows: [...] } ----
  if (parsed !== null && typeof parsed === "object") {
    const rows = (parsed as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];

    /* rows が無い＝結果ではない。よくあるのはエラーの JSON。
       ここを [] にしてしまうと「0件」と見分けが付かなくなる。 */
    throw new Error(
      "SQLの結果に行（rows）がありません。失敗した可能性があります。\n" +
        `  受け取った内容：${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }

  throw new Error(`SQLの結果の形が分かりません：${String(parsed).slice(0, 200)}`);
}

/** SQL を流して、返ってきた行を受け取る。読めなければ例外で止まる */
export function runSql<T = Record<string, unknown>>(sql: string): T[] {
  const dir = mkdtempSync(path.join(tmpdir(), "kasshi-sql-"));
  const file = path.join(dir, "q.sql");
  try {
    writeFileSync(file, sql, "utf8");

    /* シェル経由で呼ぶ（Windows では npx が .cmd のため、直接起動できない）。
       渡すのは自分で作った一時ファイルの場所だけ。外から来た文字は入らない。

       --output-format json … 人が使っていても機械が読める形にそろえる。
                               これが無いと、画面では罫線の表が返る。
       spawnSync            … stderr も受け取る（失敗の理由を残すため）。 */
    const r = spawnSync(
      `npx supabase db query --linked --output-format json --file "${file}"`,
      { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );

    if (r.error) throw new Error(`SQLを流せませんでした：${r.error.message}`);

    return parseQueryOutput<T>({ status: r.status, stdout: r.stdout, stderr: r.stderr });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 文字列を SQL の中へ安全に入れる。null はそのまま NULL に */
export function lit(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  // ' を '' にして囲む。制御文字も落とさずそのまま渡すため E'' は使わない
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 表の名前・列の名前を SQL の中へ入れる（" で囲む） */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`使えない名前です: ${name}`);
  return `"${name}"`;
}

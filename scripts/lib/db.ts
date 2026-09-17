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
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** SQL を流して、返ってきた行を受け取る */
export function runSql<T = Record<string, unknown>>(sql: string): T[] {
  const dir = mkdtempSync(path.join(tmpdir(), "kasshi-sql-"));
  const file = path.join(dir, "q.sql");
  try {
    writeFileSync(file, sql, "utf8");
    /* シェル経由で呼ぶ（Windows では npx が .cmd のため、直接起動できない）。
       渡すのは自分で作った一時ファイルの場所だけ。外から来た文字は入らない。 */
    const out = execSync(`npx supabase db query --linked --file "${file}"`, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

    // 先頭に案内文が付くことがあるので、JSON の始まりから読む
    const start = out.indexOf("{");
    if (start < 0) return [];
    const parsed = JSON.parse(out.slice(start)) as { rows?: T[] };
    return parsed.rows ?? [];
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

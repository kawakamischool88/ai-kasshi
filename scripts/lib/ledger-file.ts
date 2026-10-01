/**
 * 台帳のファイルを扱う道具（Phase C）。DB に触れないので、テストから直接呼べる。
 *
 * 【台帳は、足していくだけ。ただし1つだけ例外】
 * 本人が記憶の系列を消したら、変更台帳にあるその系列の**本文だけ**を消す（G2）。
 * 行そのもの・番号・版のつながり・日時は消さない・書き換えない。
 *
 * 【書き直しで台帳を壊さない】
 * ① 同じフォルダの一時ファイルに書く
 * ② 一時ファイルを読み直して、行数と中身を確かめる
 * ③ 確かめ終えてから、元の台帳と置き換える（置き換えは一度に行われる）
 * 途中で何が起きても、元の台帳はそのまま残る。一時ファイルは消す。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";

export type Row = Record<string, unknown>;

/** 台帳を読む。読めない行が1つでもあれば止める（壊れた台帳を書き直さないため） */
export function readLedgerFile(file: string): Row[] {
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      throw new Error(`台帳の ${i + 1} 行目を読めません（中身は表示しません）。台帳を直してから実行してください。`);
    }
  });
  return rows;
}

export function keyOf(row: Row, key: readonly string[]): string {
  return key.map((k) => String(row[k])).join("|");
}

/** まだ台帳に無い行だけを足す。足した件数を返す */
export function appendNewRows(file: string, key: readonly string[], rows: Row[]): number {
  const known = new Set(readLedgerFile(file).map((r) => keyOf(r, key)));
  const fresh: Row[] = [];
  for (const r of rows) {
    const k = keyOf(r, key);
    if (known.has(k)) continue;
    known.add(k);
    fresh.push(r);
  }
  if (fresh.length === 0) return 0;
  appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return fresh.length;
}

/**
 * 変更台帳から、消した系列の本文を消す（G2）。
 *
 * @param deleted 消した記憶の番号 → 消した日時（削除台帳から作る）
 * @returns 書き換えた後の行と、本文を消した件数
 */
export function scrubRevisionRows(
  rows: Row[],
  deleted: Map<string, string | null>,
): { rows: Row[]; scrubbed: number } {
  let scrubbed = 0;
  const out = rows.map((r) => {
    const id = String(r.id);
    if (!deleted.has(id)) return r;
    const already = r.deleted === true && r.text == null;
    if (already) return r;
    scrubbed += 1;
    return {
      ...r,
      text: null,
      deleted: true,
      deleted_at: (r.deleted_at as string | null | undefined) ?? deleted.get(id) ?? null,
    };
  });
  return { rows: out, scrubbed };
}

/**
 * 消した系列の行に、本文が残っていないかを数える。
 * 「削除済み」の印がある行と、削除台帳に番号がある行の両方を見る。
 */
export function countTextInDeleted(rows: Row[], deleted: Map<string, string | null>): number {
  return rows.filter((r) => (r.deleted === true || deleted.has(String(r.id))) && r.text != null).length;
}

/**
 * 台帳を安全に書き直す。
 *
 * @param verify 読み直した行を確かめる。問題があれば例外を投げる（置き換えない）
 * @param hooks テスト用：一時ファイルを書いた直後に呼ぶ（途中で止まったことをまねる）
 */
export function rewriteLedgerSafely(
  file: string,
  rows: Row[],
  verify: (reread: Row[]) => void,
  hooks: { afterTempWrite?: (tempFile: string) => void } = {},
): void {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    hooks.afterTempWrite?.(temp);

    const reread = readLedgerFile(temp);
    if (reread.length !== rows.length) {
      throw new Error(`書き直した台帳の行数が合いません（${reread.length} / ${rows.length}）`);
    }
    verify(reread);

    renameSync(temp, file);
  } finally {
    // 置き換え済みなら一時ファイルはもう無い。途中で止まったときだけ残っているので消す
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

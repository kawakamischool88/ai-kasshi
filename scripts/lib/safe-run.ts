/**
 * 台帳・バックアップ・復元のスクリプトを、本文を表示せずに動かす（Phase C）。
 *
 * 【なぜ要るか】
 * SQL が失敗したときの詳しいエラーには、DB の行の値（本文）が入ることがある。
 * そのまま画面に出すと、開発用のAIツールが画面を読んだときに本文が渡ってしまう。
 *
 * ふだんは、失敗したことと DB のエラーの番号（5文字）だけを表示する。
 * 運営者が自分で詳しく見たいときだけ、環境変数 AI_KASSHI_SHOW_SQL_ERROR=1 を付けて
 * 実行する（開発用のAIツールには付けさせない）。
 */

/** エラーの文から、DB のエラーの番号（5文字）だけを探す。見つからなければ null */
export function sqlStateOf(message: string): string | null {
  const m =
    message.match(/SQLSTATE[\s:=]*([0-9A-Z]{5})\b/) ??
    message.match(/"code"\s*:\s*"([0-9A-Z]{5})"/) ??
    message.match(/\(SQLSTATE ([0-9A-Z]{5})\)/);
  return m ? m[1] : null;
}

/** 本文を含みうるエラーを、表示してよい1行にする */
export function safeErrorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // スクリプト自身が出す「中止：…」の文は、本文を含まない作りなので、そのまま出す
  if (message.startsWith("中止：") || message.startsWith("台帳の ")) return message.split("\n")[0];
  const code = sqlStateOf(message);
  return `SQL などの処理に失敗しました（DB のエラーの番号：${code ?? "不明"}）。詳しい内容は表示しません。`;
}

export function runMain(main: () => void | Promise<void>): void {
  Promise.resolve()
    .then(main)
    .catch((e) => {
      if (process.env.AI_KASSHI_SHOW_SQL_ERROR === "1") {
        console.error(e);
      } else {
        console.error(`× ${safeErrorLine(e)}`);
        console.error("  （運営者が自分で詳しく見るときだけ、AI_KASSHI_SHOW_SQL_ERROR=1 を付けて実行してください）");
      }
      process.exit(1);
    });
}

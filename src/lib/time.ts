/**
 * 日時の扱いは、このファイルにまとめる。
 *
 * 【なぜ必要か】
 * 画面はサーバー側で作られる。本番（Vercel）のサーバーは世界標準時で動くため、
 * 時間帯を指定せずに日本語表記へ変換すると、**9時間前の日時が表示される**。
 * 手元のパソコンは日本時間なので、開発中は正しく見えてしまい気づけない。
 * （2026-09-17、本番確認で実際に発生。会話一覧の日時が9時間ずれていた）
 *
 * そのため、画面に日時を出すときは必ずこのファイルの関数を使い、
 * `toLocaleString` を直接書かないこと。
 */
const JST = "Asia/Tokyo";

/** 画面表示用：日本時間の「2026年9月17日 18:30」 */
export function formatDateTimeJst(value: Date | string): string {
  return new Date(value).toLocaleString("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 画面表示用：日本時間の「2026/9/1」 */
export function formatDateJst(value: Date | string): string {
  return new Date(value).toLocaleDateString("ja-JP", { timeZone: JST });
}

/** 日本時間での「今月1日 0時」を返す（原価の集計期間の始まり） */
export function monthStartJst(now: Date = new Date()): Date {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const startOfMonthJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1);
  return new Date(startOfMonthJst - JST_OFFSET_MS);
}

/** 日本時間の「YYYY-MM-DD」 */
export function dateKeyJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** 日本時間での「その月の1日 0時」と「翌月1日 0時」（Phase 4C） */
export function monthRangeJst(
  offsetMonths: number,
  now: Date = new Date(),
): { start: Date; end: Date; label: string } {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + offsetMonths;

  const start = new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS);
  const end = new Date(Date.UTC(year, month + 1, 1) - JST_OFFSET_MS);

  // 見出し用の「2026年9月」。月がまたがっても正しく出るよう、開始日から作る
  const label = new Date(start).toLocaleDateString("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "long",
  });
  return { start, end, label };
}

/** 画面・PDF表示用：日本時間の「2026年9月5日」 */
export function formatDayJst(value: Date | string): string {
  return new Date(value).toLocaleDateString("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

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

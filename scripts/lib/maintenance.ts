/**
 * 自動の期限処理（Phase B）の点検の判定。
 *
 * DB から読んだ「件数と日時だけ」を受け取り、運営者に見せる行を作る。
 * 本文・メールアドレス・利用者や候補の番号は、受け取らないし、出さない。
 * DB に触れないので、テストで直接確かめられる。
 */

/** 点検に使う値（すべて件数・日時・名前だけ） */
export type MaintenanceStatus = {
  /** 最後に「正常に」期限処理が動いた日時と件数 */
  lastOk: { ranAt: string; affected: number } | null;
  /** 最後に期限処理が動いた日時（成否を問わず）と、失敗なら DB のエラーの番号 */
  lastRun: { ranAt: string; ok: boolean; errorCode: string | null } | null;
  /** 期限を1日以上過ぎているのに「確認待ち」のまま残っている件数 */
  overdue: number;
  /** 登録されている定期実行（名前・予定・有効か） */
  jobs: { name: string; schedule: string; active: boolean }[];
  /** 定期実行の仕組みが残す、期限処理の最後の結果（succeeded / failed など）と終わった日時 */
  lastCron: { status: string; endTime: string | null } | null;
};

export type Judgement = { level: "ok" | "warn" | "ng"; lines: string[] };

export const EXPIRE_JOB = "ai-kasshi-expire-candidates";
export const HISTORY_JOB = "ai-kasshi-cron-history-cleanup";

/** 最後の正常実行から、これより時間がたっていたら異常（毎日1回なので、1日半） */
export const STALE_HOURS = 36;

function jst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

/** 数字・英字・記号の短い名前だけを出す（念のため、知らない形は伏せる） */
function safeWord(s: string): string {
  return /^[A-Za-z0-9_* -]{1,40}$/.test(s) ? s : "（表示しない）";
}

export function judgeMaintenance(s: MaintenanceStatus, now = new Date()): Judgement {
  const lines: string[] = [];
  let level: Judgement["level"] = "ok";
  const ng = (m: string) => {
    level = "ng";
    lines.push(`  × ${m}`);
  };
  const warn = (m: string) => {
    if (level === "ok") level = "warn";
    lines.push(`  △ ${m}`);
  };

  // --- 定期実行の登録 ---
  for (const name of [EXPIRE_JOB, HISTORY_JOB]) {
    const job = s.jobs.find((j) => j.name === name);
    if (!job) ng(`定期実行「${name}」が登録されていません`);
    else if (!job.active) ng(`定期実行「${name}」が止まっています（予定 ${safeWord(job.schedule)}）`);
    else lines.push(`  ○ 定期実行「${name}」：有効（予定 ${safeWord(job.schedule)}・世界標準時）`);
  }

  // --- 最後の正常実行 ---
  if (!s.lastOk) {
    warn("期限処理はまだ一度も正常に動いていません（入れた直後なら、次の日本時間 3:15 を待ってください）");
  } else {
    const hours = (now.getTime() - new Date(s.lastOk.ranAt).getTime()) / 3_600_000;
    const text = `最後に正常に動いた日時：${jst(s.lastOk.ranAt)}（期限切れにした件数 ${s.lastOk.affected} 件）`;
    if (hours > STALE_HOURS) ng(`${text} … ${STALE_HOURS}時間以上たっています`);
    else lines.push(`  ○ ${text}`);
  }

  // --- 最後の実行が失敗していないか ---
  if (s.lastRun && !s.lastRun.ok) {
    const code = s.lastRun.errorCode && /^[0-9A-Z]{5}$/.test(s.lastRun.errorCode) ? s.lastRun.errorCode : "不明";
    ng(`最後の実行（${jst(s.lastRun.ranAt)}）は失敗しました（DB のエラーの番号 ${code}）`);
  }
  if (s.lastCron && s.lastCron.status === "failed") {
    ng(`定期実行の仕組みの記録で、最後の期限処理が失敗になっています${s.lastCron.endTime ? `（${jst(s.lastCron.endTime)}）` : ""}`);
  }

  // --- 期限を過ぎたのに残っているもの ---
  if (s.overdue > 0) {
    ng(`期限を1日以上過ぎているのに「確認待ち」のままの候補：${s.overdue} 件`);
  } else {
    lines.push("  ○ 期限を1日以上過ぎているのに「確認待ち」のままの候補：0 件");
  }

  return { level, lines };
}

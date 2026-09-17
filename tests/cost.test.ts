/**
 * 原価計算としきい値判定のテスト。
 * 外部への接続はしない（計算だけを確かめる）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { PRICING } from "@/config/ai";
import { estimateCostUsd, EMPTY_USAGE, usdToJpy } from "@/lib/ai/cost";
import { judgeBudget } from "@/lib/ai/budget";
import { monthStartJst, dateKeyJst, formatDateTimeJst, formatDateJst } from "@/lib/time";

const MODEL = "claude-sonnet-5";

describe("推定原価", () => {
  it("公式単価どおりに計算する（入力$2 / 出力$10 per 100万）", () => {
    const r = estimateCostUsd(MODEL, {
      ...EMPTY_USAGE,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(r.priced).toBe(true);
    expect(r.usd).toBe(12); // 2 + 10
    expect(r.currency).toBe("USD");
  });

  it("キャッシュぶんも単価どおりに足す", () => {
    const r = estimateCostUsd(MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_5m_tokens: 1_000_000,
      cache_creation_1h_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(r.usd).toBe(2.5 + 4 + 0.2);
  });

  it("1往復ぶんの現実的な値（入力3900 / 出力700）", () => {
    const r = estimateCostUsd(MODEL, {
      ...EMPTY_USAGE,
      input_tokens: 3_900,
      output_tokens: 700,
    });
    // 3900/1e6*2 + 700/1e6*10 = 0.0078 + 0.007
    expect(r.usd).toBeCloseTo(0.0148, 6);
  });

  it("使っていなければ 0 円", () => {
    expect(estimateCostUsd(MODEL, EMPTY_USAGE).usd).toBe(0);
  });

  it("小数第6位までに丸める（DBの桁に合わせる）", () => {
    const r = estimateCostUsd(MODEL, { ...EMPTY_USAGE, input_tokens: 1 });
    expect(r.usd).toBe(0.000002);
  });

  it("単価表にないモデルは金額を出さず、その旨を返す", () => {
    const r = estimateCostUsd("未登録のモデル", { ...EMPTY_USAGE, input_tokens: 1_000_000 });
    expect(r.priced).toBe(false);
    expect(r.usd).toBe(0);
  });

  it("単価の版と日付を必ず付ける（後から請求と突き合わせるため）", () => {
    const r = estimateCostUsd(MODEL, EMPTY_USAGE);
    expect(r.version).toBe(PRICING.version);
    expect(r.date).toBe(PRICING.date);
  });

  it("円換算は目安として整数で返す", () => {
    expect(usdToJpy(1)).toBe(PRICING.jpyPerUsd);
  });
});

describe("原価の安全装置（しきい値）", () => {
  it("警告値の手前は通常", () => {
    expect(judgeBudget(14.99, 15, 40)).toBe("ok");
  });
  it("警告値ちょうどで警告", () => {
    expect(judgeBudget(15, 15, 40)).toBe("warning");
  });
  it("停止値ちょうどで停止", () => {
    expect(judgeBudget(40, 15, 40)).toBe("stopped");
  });
  it("停止値を超えても停止のまま", () => {
    expect(judgeBudget(999, 15, 40)).toBe("stopped");
  });
});

describe("集計期間（日本時間）", () => {
  it("月初は日本時間の1日0時＝前日15時UTC", () => {
    const start = monthStartJst(new Date("2026-09-17T03:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });

  it("日本時間の早朝でも、その月の初日を返す", () => {
    // UTC では 8/31 だが、日本時間では 9/1 の朝
    const start = monthStartJst(new Date("2026-08-31T22:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });

  it("日付のまとめ方も日本時間", () => {
    expect(dateKeyJst(new Date("2026-09-16T16:00:00Z"))).toBe("2026-09-17");
  });
});

/**
 * 本番（Vercel）のサーバーは世界標準時で動く。
 * 画面に出す日時が、サーバーの時間帯に引きずられて9時間ずれる不具合が
 * 実際に起きたため、どの時間帯でも日本時間で出ることを固定しておく。
 */
describe("画面に出す日時（日本時間で固定）", () => {
  const 元のTZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = 元のTZ;
  });

  it("日時：日本時間で表示する", () => {
    // 世界標準時 9:30 ＝ 日本時間 18:30
    expect(formatDateTimeJst("2026-09-17T09:30:00Z")).toBe("2026年9月17日 18:30");
  });

  it("日時：サーバーが世界標準時でも同じ表示になる", () => {
    process.env.TZ = "UTC";
    expect(formatDateTimeJst("2026-09-17T09:30:00Z")).toBe("2026年9月17日 18:30");
  });

  it("日時：日付をまたぐ時刻でも正しい", () => {
    // 世界標準時 9/16 16:00 ＝ 日本時間 9/17 1:00
    process.env.TZ = "UTC";
    expect(formatDateTimeJst("2026-09-16T16:00:00Z")).toBe("2026年9月17日 01:00");
  });

  it("日付：集計の開始日が日本時間の1日になる", () => {
    process.env.TZ = "UTC";
    // monthStartJst が返す「日本時間の9月1日0時」＝ 世界標準時 8/31 15:00
    expect(formatDateJst(monthStartJst(new Date("2026-09-17T03:00:00Z")))).toBe("2026/9/1");
  });

  it("日付：Date でも文字列でも同じ結果になる", () => {
    const iso = "2026-09-17T09:30:00Z";
    expect(formatDateJst(iso)).toBe(formatDateJst(new Date(iso)));
  });
});

import { PRICING } from "@/config/ai";

/**
 * 原価の計算は、このファイルの estimateCostUsd ただ1つで行う。
 * 他の場所で掛け算をしないこと（単価変更のときに直し漏れるため）。
 */

/** APIの usage から写した、課金に関わるトークン数 */
export type UsageCounts = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cache_read_input_tokens: number;
};

export const EMPTY_USAGE: UsageCounts = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_5m_tokens: 0,
  cache_creation_1h_tokens: 0,
  cache_read_input_tokens: 0,
};

export type CostEstimate = {
  /** 推定原価（USD）。小数第6位まで */
  usd: number;
  /** 単価表にそのモデルが載っていれば true。false のときは usd が 0 で参考にならない */
  priced: boolean;
  version: string;
  date: string;
  currency: string;
};

/**
 * 推定原価を出す。
 *
 * 単価は 100万トークンあたりの USD。
 * 思考ぶんのトークンは output_tokens に含まれているので、別に足さない
 * （足すと二重に数えてしまう）。
 */
export function estimateCostUsd(model: string, usage: UsageCounts): CostEstimate {
  const base = {
    version: PRICING.version,
    date: PRICING.date,
    currency: PRICING.currency,
  };

  const rates = (PRICING.models as Record<string, (typeof PRICING.models)[keyof typeof PRICING.models] | undefined>)[
    model
  ];
  if (!rates) {
    // 単価表にないモデル。トークン数は記録するが、金額は出せない
    return { usd: 0, priced: false, ...base };
  }

  const perMillion =
    usage.input_tokens * rates.input +
    usage.output_tokens * rates.output +
    usage.cache_creation_5m_tokens * rates.cacheWrite5m +
    usage.cache_creation_1h_tokens * rates.cacheWrite1h +
    usage.cache_read_input_tokens * rates.cacheRead;

  const usd = perMillion / 1_000_000;

  // DB の numeric(12,6) に合わせて小数第6位で丸める
  return { usd: Math.round(usd * 1_000_000) / 1_000_000, priced: true, ...base };
}

/** 画面表示用の円換算（目安。実際の請求はドル建て） */
export function usdToJpy(usd: number): number {
  return Math.round(usd * PRICING.jpyPerUsd);
}

/**
 * 画面表示用の文字列（例：「$0.42（約63円）」）。
 * 1セント未満は $0.00 になって読めないので、小さい金額は桁を増やす。
 */
export function formatCost(usd: number): string {
  const dollars = usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  const yen = usd > 0 && usdToJpy(usd) === 0 ? "1円未満" : `約${usdToJpy(usd).toLocaleString("ja-JP")}円`;
  return `${dollars}（${yen}）`;
}

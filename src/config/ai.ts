/**
 * AI に関する設定は、すべてこのファイルに集める。
 *
 * 【なぜ1箇所にまとめるか】
 * モデル名や単価をコードのあちこちに書くと、値上げ・モデル変更のたびに
 * 探し回ることになり、直し漏れが起きる。ここだけ見れば済むようにする。
 *
 * 【単価を変えるとき】
 * PRICING の数字と version / date を直して、git に push するだけでよい。
 * DB の作り替え（migration）は不要。過去の記録には、その時点の版が
 * 残っているので、後から「いつの単価で計算したか」が分かる。
 */

/** 会話に使うモデルなどの設定 */
export const AI = {
  provider: "anthropic",

  /**
   * Claude API のモデルID（2026-09-17 に公式ドキュメントで確認）。
   * 公開日 2026-06-30、提供終了は 2027-06-30 以降。
   * 入力 $2 / 出力 $10 per 100万トークン。思考は「適応型」で既定でオン。
   */
  model: "claude-sonnet-5",

  /**
   * 考える深さ。high が既定だが、会話用途では medium で十分なことが多く、
   * 速さと費用の釣り合いが良い。品質が足りなければ high へ上げる。
   */
  effort: "medium" as const,

  /** 1回の返答の上限。長すぎる返答は読みづらく、費用も増える */
  maxTokens: 2000,

  /** AIへ渡す直近のやりとりの数（これより前は送らない） */
  contextMessageCount: 20,

  /** 1回に送れる文字数。音声入力で長く話しても収まる長さ */
  maxInputChars: 4000,

  /** 通信エラー時にSDKが自動でやり直す回数（これとは別に画面の「もう一度試す」がある） */
  maxRetries: 1,

  /** 1回の呼び出しを待つ上限 */
  timeoutMs: 120_000,
} as const;

/**
 * 公式API単価（USD / 100万トークン）。
 * 2026-09-17 に https://platform.claude.com/docs/en/about-claude/pricing で確認。
 *
 * Sonnet 5 の $2 / $10 は「導入価格」ではなく正式な標準価格
 * （2026-09-01 に予定されていた $3 / $15 への値上げは行われないと公式に告知済み）。
 */
export const PRICING = {
  version: "2026-09-17",
  date: "2026-09-17",
  currency: "USD",

  /** 表示用のドル円レート。請求はドル建てなので、これは目安 */
  jpyPerUsd: 150,

  models: {
    "claude-sonnet-5": {
      /** 通常の入力 */
      input: 2.0,
      /** 出力（思考ぶんもここに含まれる） */
      output: 10.0,
      /** 5分キャッシュへの書き込み */
      cacheWrite5m: 2.5,
      /** 1時間キャッシュへの書き込み */
      cacheWrite1h: 4.0,
      /** キャッシュからの読み出し */
      cacheRead: 0.2,
    },
  },
} as const;

export type PricedModel = keyof typeof PRICING.models;

/**
 * 原価の安全装置（1か月あたり・USD）。
 *
 * Vercel の環境変数で上書きできる。金額を変えるのにコードの変更は要らない。
 *   AI_MONTHLY_WARNING_USD … 警告値
 *   AI_MONTHLY_STOP_USD    … 停止値
 *
 * 【初期値の根拠】1往復あたりの実測見込みは約 $0.015（約2円）。
 *   ふだんの使い方（1日20往復）で月およそ $9。
 *   警告 $15 … ふだんの1.5倍。超えたら気づけるようにする
 *   停止 $40 … 連打・暴走が起きても、ここで新しいAI処理を止める
 */
export const BUDGET = {
  monthlyWarningUsd: Number(process.env.AI_MONTHLY_WARNING_USD ?? 15),
  monthlyStopUsd: Number(process.env.AI_MONTHLY_STOP_USD ?? 40),
} as const;

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
 * 記憶候補の抽出（Phase 3A）。
 *
 * 会話の返事とは別の呼び出しにしてある。
 * **将来、抽出だけ安いモデルへ変えたいときは、ここの model を書き換えるだけでよい。**
 * 利用量は operation_type = "memory_extract" として別に記録される。
 */
export const MEMORY = {
  /** 抽出に使うモデル。会話と分けてあるので、ここだけ安いモデルにできる */
  model: "claude-sonnet-5",
  effort: "medium" as const,
  /** 候補は短い文なので、返事より小さくてよい */
  maxTokens: 1000,

  /** 抽出のときにAIへ見せる直近のやりとりの数（指示語を解くのに必要な最小限） */
  contextMessageCount: 6,

  /** 1回の会話から作る候補の上限。多く出しすぎないことを優先する */
  maxCandidates: 2,

  /** 候補が期限切れになるまでの日数 */
  expireDays: 30,
} as const;

/**
 * 確定記憶の検索（Phase 3B）。
 *
 * 【なぜ「意味の近さ」をAIに選ばせるのか】
 * Anthropic は文章を数値に変換する仕組み（embedding）を提供しておらず、
 * 公式には他社（Voyage AI など）を案内している。
 * それを使うと **AI提供元がもう1社増える**（Phase 2 で「Anthropic 1社のみ」と決めた方針に反する）。
 *
 * いまの規模（利用者1名・記憶は数十件）なら、
 * 「本人の確定記憶を絞って渡し、関係するものをAIに選ばせる」方法で十分に意味の近さを見られる。
 * 日本語の言い換えにも強く、人名・商品名もそのまま読める。
 *
 * 記憶は本文をそのまま保存してあるので、
 * 将来 embedding を使うことになっても、原文から作り直せる。
 */
export const SEARCH = {
  /** 関係する記憶を選ぶのに使うモデル。将来ここだけ安いモデルにできる */
  model: "claude-sonnet-5",
  /** 選ぶだけの作業なので浅くてよい */
  effort: "low" as const,
  maxTokens: 300,

  /**
   * DBから確定記憶を読むときの1回ぶんの件数（Phase 3D）。
   *
   * 【上限で打ち切らない】
   * 以前は200件で打ち切っていたため、記憶が増えると
   * **201件目から先が黙って検索対象から外れていた**。
   * いまは最後まで読み切る（下の maxFetch は暴走を止めるためだけの数）。
   */
  pageSize: 100,

  /** 読み切りの安全弁。ここに達したら打ち切り、記録に残す */
  maxFetch: 20_000,
  /** AIに見せて選ばせる件数の上限 */
  candidateLimit: 40,
  /** AIに見せる記憶の合計文字数の上限 */
  candidateChars: 4000,

  /** 回答へ渡す記憶の件数の上限 */
  maxInject: 3,
  /** 回答へ渡す記憶の合計文字数の上限 */
  injectChars: 600,

  /**
   * 「昔はどう考えていた？」と聞かれたときに、検索へ加える過去の考えの上限（Phase 3C）。
   * ふだんの会話では0件（現在有効な内容だけを見る）。
   */
  pastFetchLimit: 50,
} as const;

/**
 * 記憶の訂正・考えの変化・削除の「対象探し」（Phase 3C）。
 *
 * 【AIにできるのは探すところまで】
 * ここで呼ぶAIは、対象を挙げて新しい文章の案を書くだけ。
 * 実際に記憶を書き換えるのは、本人が画面でボタンを押したときだけ。
 *
 * ふだんの会話では呼ばない。
 * 「消して」「違う」「考えが変わった」といった言い方が出たときだけ呼ぶ
 * （src/config/revision-prompt.ts の detectRevisionIntent）。
 */
export const REVISE = {
  model: "claude-sonnet-5",
  /** 探して1〜2件挙げるだけなので浅くてよい */
  effort: "low" as const,
  maxTokens: 600,

  /** AIに見せる記憶の件数の上限 */
  candidateLimit: 40,
  /** AIに見せる記憶の合計文字数の上限 */
  candidateChars: 4000,

  /** 本人に見せる提案の件数の上限（曖昧なときだけ2件） */
  maxTargets: 2,
  /** 新しい文章の案の長さの上限 */
  maxTextChars: 500,
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

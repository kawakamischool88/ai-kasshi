/**
 * 振り返りPDFの設定（Phase 4C）。
 *
 * 【これは何か】
 * 本人が「この期間、自分は何を話し、何をカッシーに残したのか」を
 * 読み返すための資料。
 *
 * 【これは何ではないか】
 * ・バックアップではない（それは Phase 4A）
 * ・データの持ち出しでもない（それは Phase 4B の「自分のデータを書き出す」）
 * 目的が違うので、載せるものも違う。混ぜないこと。
 *
 * 【いちばん大事な決まり】
 * **本人が確定した文章を、そのまま載せる。**
 * AIに要約させたり、言い換えたりしない。意味が変わってしまうため。
 */

/** 対象の期間。Ver.0.1 は今月と先月だけ */
export type PdfPeriod = "this" | "last";

export const PDF_PERIODS: { key: PdfPeriod; label: string }[] = [
  { key: "this", label: "今月" },
  { key: "last", label: "先月" },
];

export function isPdfPeriod(value: string | null): value is PdfPeriod {
  return value === "this" || value === "last";
}

/**
 * PDFに載せるもの・載せないもの。
 *
 * 【載せない理由】
 * 本人が確定していないもの、消したものを載せてしまうと、
 * Phase 3A〜4B で作ってきた約束が、PDF経由で崩れる。
 */
export const PDF_INCLUDES = [
  "その期間に本人が確定した、いま有効な記憶",
  "その期間に本人が訂正した内容（訂正前と現在）",
  "その期間に本人の考えが変わった内容（以前の考えと現在の考え）",
  "情報の由来",
  "本人が確定した日",
  "元の会話の見出し",
] as const;

export const PDF_EXCLUDES: { name: string; reason: string }[] = [
  { name: "確認待ちの候補", reason: "本人がまだ残すと決めていないため" },
  { name: "「残さない」と決めた候補", reason: "本人が残さないと決めたため。本文も保存していない" },
  { name: "期限が過ぎた候補", reason: "本人が確認しないまま期限が過ぎたため。本文も保存していない" },
  {
    name: "消した記憶の本文",
    reason: "本人が消したものを、PDF経由で復活させないため。件数も載せない",
  },
  { name: "本人が採用していないAIの提案", reason: "本人の考えではないため" },
  { name: "AIによる人物像・性格・価値観の推測", reason: "そもそも作っていない" },
  { name: "ほかの利用者の情報", reason: "自分のぶんだけが載る" },
  { name: "内部の番号（ID）", reason: "本人には不要で、読みにくくなるため" },
  { name: "AIの利用量・推定原価", reason: "運営側の管理用の記録のため" },
  { name: "会話の全文", reason: "読み返すための資料なので、確定した記憶を中心にする" },
] as const;

/**
 * 由来の書き方。
 *
 * 【意味を変えない】
 * 本人の認識なのか、第三者の発言なのか、検討中の案なのかを、
 * PDFでもそのまま保つ。「本人はこう考えている」を
 * 「これはこうである」に書き換えてはいけない。
 */
export const PDF_ORIGIN_LABEL: Record<string, string> = {
  self_experience: "ご本人の経験・お考えとして残したもの",
  third_party: "ほかの方の話として、ご本人が紹介したもの",
  tentative: "検討中のお考えとして残したもの",
  ai_adopted: "AIカッシーの案を、ご本人が採用したもの",
  ai_suggestion: "AIカッシーの案（ご本人は採用していません）",
};

/** PDFに載せてよい由来。未採用のAI案は載せない */
export const PDF_ALLOWED_ORIGINS = [
  "self_experience",
  "third_party",
  "tentative",
  "ai_adopted",
] as const;

/** 紙の設定（A4・読みやすさ優先） */
export const PDF_LAYOUT = {
  /** A4（ポイント） */
  pageWidth: 595.28,
  pageHeight: 841.89,
  margin: 56,

  /** 文字の大きさ。60代後半の方が読むことを前提に、やや大きめ */
  titleSize: 20,
  periodSize: 13,
  sectionSize: 15,
  bodySize: 12,
  noteSize: 10.5,

  /** 行の高さ（文字の大きさに対する倍率） */
  lineHeight: 1.75,
} as const;

/** PDFに入っていてはいけない語（作ったあと毎回調べる） */
export const FORBIDDEN_IN_PDF = [
  "sb_secret_",
  "sb_publishable_",
  "sk-ant-",
  "eyJhbGciOi",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "service_role",
  "SUPABASE_URL",
] as const;

/**
 * 保存について。
 *
 * **サービス側には保存しない。**
 * 押されたその場で作って渡す。だから次のものが要らない。
 *   ・PDFの置き場所の管理
 *   ・PDFのバックアップ
 *   ・PDFの保存期間
 *   ・訂正・削除したときに、保存済みPDFを無効にする仕組み
 */
export const PDF_STORAGE = { storeOnServer: false } as const;

/** 本人の機器に保存されたPDFについての案内（画面とPDFの両方に出す） */
export const PDF_KEEP_NOTICE =
  "このPDFは、いったんご自身の機器へ保存すると、AIカッシー側から削除できません。保管にはご注意ください。";

/**
 * 本番の DB へ流す SQL が、本文を読むものでないかを確かめる（Phase E ／ E2・統合設計 T-3）。
 *
 * 【なぜ要るか】
 * 運営の命令（scripts/）から本番の DB を読むとき、うっかり会話や記憶の本文・メールアドレスを
 * 取り出す問い合わせを書くと、その結果が画面（＝開発用のAIツールが読める場所）に出てしまう。
 * 本番で通してよいのは、件数・状態・日時・構造など、本文を含まない問い合わせだけにする。
 *
 * 【例外（本文を扱うこと自体が目的の命令）】
 * 次の命令だけが、自分の目的の分だけ本文の列を扱える。どれも「結果を画面に出さない」作り。
 *   backup         … 控えのファイルへ書く（行を丸ごと読む）
 *   ledger         … 変更台帳へ書く（消していない訂正の本文）
 *   account-lookup … メールアドレスで利用者を探す（返すのは番号と登録日だけ）
 *   recover-apply  … 本番を戻した直後の当て直しと点検（本文を消す・「本文が無いこと」を数える）
 *
 * 【これで防げないもの】
 * SQL の文字を見て判断するので、わざと書き換えれば通り抜けられる。「うっかり」を止めるための守り。
 * 運営者が Supabase の画面で直接見るものは止められない（AGENTS.md の決まりで守る）。
 */

export type SqlPurpose = "counts" | "backup" | "ledger" | "account-lookup" | "recover-apply";

/** 本文・本人の自由記述・メールアドレスなどを持つ列の名前 */
const CONTENT_COLUMNS = [
  "content", // 発言・AIの返事
  "suggested_text", // 記憶の候補・残した内容・訂正前・以前の考え
  "confirmed_text",
  "extraction_reason", // AIが候補にした理由
  "proposed_text", // 提案の文章の案
  "reason", // 提案の理由
  "title", // 会話の見出し
  "display_name", // 表示名
  "memo", // 動作確認用のメモ
  "email", // メールアドレス
  "phone",
  "raw_user_meta_data",
  "raw_app_meta_data",
  "identity_data",
  "encrypted_password",
  "user_agent",
  "ip",
] as const;

/** 行を丸ごと取り出す書き方（列の名前を書かなくても本文が出てしまう） */
const WHOLE_ROW = [/\bto_jsonb\s*\(/i, /\brow_to_json\s*\(/i, /\bjson_agg\s*\(/i, /\bjsonb_agg\s*\(\s*\w+\s*\)/i, /\bselect\s+\*/i, /\.\*/];

const ALLOWED: Record<SqlPurpose, { columns: readonly string[] | "all"; wholeRow: boolean }> = {
  counts: { columns: [], wholeRow: false },
  backup: { columns: "all", wholeRow: true },
  ledger: { columns: ["suggested_text", "confirmed_text"], wholeRow: false },
  "account-lookup": { columns: ["email"], wholeRow: false },
  "recover-apply": { columns: ["suggested_text", "confirmed_text", "extraction_reason", "proposed_text", "reason", "content"], wholeRow: false },
};

/** SQL の中の、文字列（'…'）とコメントを除いた部分（列の名前だけを見るため） */
function codeOnly(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "''");
}

/** 本番で流してよい SQL か。だめなら理由（列の名前だけ）を返す。よければ null */
export function prodSqlViolation(sql: string, purpose: SqlPurpose): string | null {
  const code = codeOnly(sql);
  const allowed = ALLOWED[purpose];

  if (!allowed.wholeRow) {
    for (const re of WHOLE_ROW) {
      if (re.test(code)) return "行を丸ごと取り出す書き方（本文が含まれる）";
    }
  }
  if (allowed.columns === "all") return null;
  for (const col of CONTENT_COLUMNS) {
    if (allowed.columns.includes(col)) continue;
    if (new RegExp(`\\b${col}\\b`, "i").test(code)) return `本文・本人の情報を持つ列「${col}」`;
  }
  return null;
}

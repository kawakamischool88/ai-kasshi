/**
 * 本人向けデータ書き出しの設定（Phase 4B）。
 *
 * 【Phase 4A のバックアップとは別物】
 *   バックアップ … 運営側がシステムを復旧するためのもの
 *   書き出し     … **本人が自分のデータを手元へ持っていくためのもの**
 * 目的が違うので、入れるものも作り方も分けてある。混ぜないこと。
 *
 * 【いちばん大事な決まり】
 * 本人のデータだけを書き出す。
 * そして **消したものを、書き出し経由で復活させない**。
 * Phase 3D・4A で作った削除の保証を、ここで壊してはいけない。
 */

/**
 * 書き出しの形の版。
 *
 * 将来ここを変えたら、必ず数字を上げる。
 * 古いファイルを読むときに、どの形かを見分けるため。
 */
export const EXPORT_FORMAT_VERSION = 1;

/** ZIPの中のファイル */
export const EXPORT_FILES = {
  manifest: "manifest.json",
  conversations: "conversations.json",
  messages: "messages.json",
  memories: "memories.json",
  references: "references.json",
  readme: "はじめにお読みください.txt",
} as const;

/** 読み込むときに必ず必要なファイル（1つでも欠けたら取り込みを中止する） */
export const REQUIRED_FILES = [
  EXPORT_FILES.manifest,
  EXPORT_FILES.conversations,
  EXPORT_FILES.messages,
  EXPORT_FILES.memories,
  EXPORT_FILES.references,
] as const;

/**
 * 書き出しに入れないもの。
 *
 * 「なぜ入っていないのか」を本人にも説明できるよう、理由まで残して manifest に入れる。
 */
export const NOT_EXPORTED: { name: string; reason: string }[] = [
  {
    name: "消した記憶の本文",
    reason:
      "本人が消したものを、書き出し経由で復活させないため。" +
      "消したという事実と日時だけを残します",
  },
  {
    name: "（お知らせ）記憶を消しても、そのときの会話は残ります",
    reason:
      "「記憶だけ消す」を選んだときは、元の会話はそのまま残ります（画面で読めるものと同じです）。" +
      "そのため、会話の中には消した内容と同じ話が出てくることがあります。" +
      "会話ごと消したい場合は、会話の画面から「この会話を消す」をお使いください。" +
      "なお、その会話はAIカッシーの返事には使われないよう印が付いています",
  },
  {
    name: "「残さない」を選んだ候補・期限切れの候補の本文",
    reason: "本人が残さないと決めたもの、確認しないまま期限が過ぎたものの本文は保存していません",
  },
  {
    name: "ほかの利用者のデータ",
    reason: "自分のデータだけが入ります。ほかの人の内容も、その人のIDも入りません",
  },
  {
    name: "鍵・パスワード・APIキー",
    reason: "絶対に入れません。漏れたときの被害が大きいためです",
  },
  {
    name: "AIの利用量・推定原価の記録（ai_usage）",
    reason:
      "使ったモデル名・トークン数・推定金額など、運営側の管理用の記録です。" +
      "自分の会話や記憶を別の場所で使うために必要なものではないため入れていません。" +
      "必要なときは、川上さんへお申し付けください",
  },
  {
    name: "復旧用の内部台帳",
    reason: "運営がシステムを直すためのもので、本人のデータではありません",
  },
];

/**
 * 書き出しに入っていてはいけない語。
 *
 * 作ったあと、毎回この語が混ざっていないか調べる。
 * 見つかったら渡さない。「入れないつもり」ではなく「入っていないことを確かめる」。
 */
export const FORBIDDEN_IN_EXPORT = [
  "sb_secret_",
  "sb_publishable_",
  "sk-ant-",
  "eyJhbGciOi", // JWT の先頭
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "service_role",
  "SUPABASE_URL",
] as const;

/** 記憶のいまの状態を、本人に分かる言い方にする */
export const MEMORY_STATE_LABEL: Record<string, string> = {
  confirmed: "いまの内容",
  archived: "昔の考え",
  superseded: "訂正される前の内容",
  deleted: "削除した（本文は残っていません）",
  pending: "確認待ち",
  rejected: "残さないと決めた（本文は残っていません）",
  expired: "確認しないまま期限が過ぎた（本文は残っていません）",
};

/** 情報の由来を、本人に分かる言い方にする */
export const ORIGIN_LABEL: Record<string, string> = {
  self_experience: "本人の経験・認識",
  third_party: "本人が紹介した第三者の発言",
  tentative: "仮定・検討中の案",
  ai_suggestion: "AIカッシーの提案（本人は採用していない）",
  ai_adopted: "AIカッシーの提案を本人が採用した",
};

/** なぜAIへ送らないことにしたか（Phase 3D の印） */
export const EXCLUSION_LABEL: Record<string, string> = {
  corrected: "この内容は訂正されたため、AIカッシーの返事には使いません",
  updated: "考えが変わったため、AIカッシーの返事には使いません",
  deleted: "記憶を消したため、AIカッシーの返事には使いません",
};

/** 訂正・考えの変化の種類 */
export const REVISION_LABEL: Record<string, string> = {
  correction: "訂正（前の内容は間違いだった）",
  update: "考えの変化（前の考えも残してある）",
};

/**
 * 一時ファイルの扱い（Ver.0.1）。
 *
 * **サーバーにファイルを残さない。**
 * 本人が押した、その場で作って、その場で渡し、渡し終えたら消える。
 * 置き場所が無ければ、置きっぱなしの事故も起きない。
 */
export const EXPORT_STORAGE = {
  /** サーバーに保存するか。Ver.0.1 は保存しない */
  storeOnServer: false,
  /** もし将来ためるようになったときの、保存期間の推奨値 */
  recommendedRetentionHours: 24,
} as const;

/**
 * バックアップと復元の設定（Phase 4A）。
 *
 * 【ここが唯一の「何を控えるか」の一覧】
 * 表を増やしたら、必ずここにも足すこと。
 * 足し忘れると、復元したときにその表だけ空になる。
 *
 * 【運用・災害復旧のためのもの】
 * 本人がダウンロードするためのものではない（それは Phase 4B）。
 * 復旧に必要な内部の id や状態も入れる。
 * ただし**鍵・APIキー・パスワードは入れない**。
 */

/** 控える表。並びは復元するときの順番でもある（親 → 子） */
export const BACKUP_TABLES = [
  /** 利用者の基本情報 */
  "profiles",
  /** 会話のまとまり */
  "conversations",
  /** 会話の1発言。AIへ送らない印（excluded_from_ai_at）も含む */
  "messages",
  /** 記憶の候補と確定記憶。版・訂正・考えの変化のつながりも含む */
  "memory_candidates",
  /** 出典（AIが実際に使った記憶）。消えた記憶の墓標も含む */
  "memory_references",
  /** 記憶の操作の提案（本人が決める前のもの） */
  "memory_revision_requests",
  /** 削除の記録。本文を持たない（別に台帳としても保全する） */
  "memory_deletions",
  /** AI利用量と推定原価 */
  "ai_usage",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * 控えない表と、その理由。
 *
 * 「なぜ入っていないのか」をあとから確かめられるよう、理由まで残す。
 */
export const NOT_BACKED_UP: { name: string; reason: string }[] = [
  {
    name: "confirmed_memories / past_memories",
    reason: "表ではなく見え方（view）。memory_candidates から毎回作られるので、控える必要がない",
  },
  {
    name: "auth.users（ログイン情報）",
    reason:
      "Supabase が管理する領域。パスワードの手がかりを控えに含めないため、ここでは控えない。" +
      "復元先では、同じ id で利用者を作り直す（手順書に記載）",
  },
  {
    name: "Storage のファイル",
    reason: "Phase 4A 時点で保存しているファイルは0件。将来PDFを作るときに対象へ足す",
  },
  {
    name: "環境変数・鍵・APIキー",
    reason: "**絶対に控えに含めない。** 漏れたときの被害が、データの消失より大きい",
  },
];

/**
 * 控えに入れてはいけない語。
 *
 * バックアップを作ったあと、この語が混ざっていないか毎回調べる。
 * 「入れないつもり」ではなく「入っていないことを確かめる」。
 */
export const FORBIDDEN_IN_BACKUP = [
  "sb_secret_",
  "sb_publishable_",
  "sk-ant-",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "service_role",
  "eyJhbGciOi", // JWT の先頭
] as const;

/**
 * 台帳（restoreのたびに必ず適用し直すもの）。
 *
 * 【なぜ普通のバックアップと分けるのか】
 * 古いバックアップだけを戻すと、**そのあとに行った削除まで巻き戻る**。
 * 消したはずの記憶が復活してしまう。
 *
 * そこで「削除した」「訂正した」という事実だけを、
 * **上書きされない別の台帳**に貯めておき、復元のたびに当て直す。
 */
export const LEDGERS = {
  /**
   * 削除台帳。**本文は絶対に入れない。**
   * 入れるのは、削除をもう一度当てるのに要る最小限の id と日時だけ。
   */
  deletions: {
    file: "deletions.jsonl",
    source: "memory_deletions",
    /** 台帳に入れる項目。ここに無い項目は書き出さない */
    fields: [
      "memory_id",
      "user_id",
      "source_message_id",
      "conversation_id",
      "scope",
      "deleted_at",
    ],
    /** 同じ削除を二重に持たないための鍵 */
    key: ["user_id", "memory_id"],
  },
  /**
   * 変更台帳（訂正・考えの変化）。
   *
   * 削除台帳だけでは、バックアップ後に行った訂正を戻せない。
   * 古い内容が「いま有効」として復活してしまう。
   *
   * こちらは**訂正後の本文を含む**。本人のいま有効な内容であり、
   * 失うと本人が困るため。削除台帳とは性質が違う。
   */
  revisions: {
    file: "revisions.jsonl",
    source: "memory_candidates",
    fields: [
      "id",
      "user_id",
      "conversation_id",
      "source_message_id",
      "candidate_index",
      "revision_of",
      "revision_kind",
      "version",
      "revised_at",
      "confirmed_at",
      "origin",
      "requested_by_user",
      /** 訂正後の本文。いま有効な内容なので含める */
      "text",
    ],
    key: ["id"],
  },
} as const;

/** 台帳の書き方の版。読み書きの決まりを変えたら上げる */
export const LEDGER_FORMAT_VERSION = 1;

/** バックアップの書き方の版 */
export const BACKUP_FORMAT_VERSION = 1;

/** 隔離した復元先のスキーマ名（この名前の場所へ戻す。本番の場所は触らない） */
export const RESTORE_SCHEMA = "restore";

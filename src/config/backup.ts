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
  /** 会話ごと消した記録。本文・見出しを持たない（Phase A） */
  "conversation_deletions",
  /** AI利用量と推定原価 */
  "ai_usage",
  /** 自動の処理が動いた記録。処理の名前・日時・件数・成否だけ（Phase B） */
  "maintenance_runs",
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
      /** 訂正後の本文。いま有効な内容なので含める。**その系列を本人が消したら null にする**（Phase C） */
      "text",
      /** その系列を本人が消したか（Phase C）。true の行は本文を持たない */
      "deleted",
      /** 消した日時（Phase C） */
      "deleted_at",
    ],
    key: ["id"],
  },
  /**
   * 会話の削除の台帳（Phase C ／ R1）。**本文・見出しは入れない。**
   * 古いバックアップから戻したとき、消した会話を消し直すため。
   */
  conversationDeletions: {
    file: "conversation-deletions.jsonl",
    source: "conversation_deletions",
    fields: ["conversation_id", "user_id", "deleted_at"],
    key: ["user_id", "conversation_id"],
  },
  /**
   * ［残さない］の台帳（Phase C ／ R2・N-3）。**本文・理由は入れない。**
   * 古いバックアップから本文付きの「確認待ち」として戻っても、閉じ直すため。
   */
  closures: {
    file: "closures.jsonl",
    source: "memory_candidates",
    fields: ["id", "user_id", "conversation_id", "source_message_id", "candidate_index", "status", "decided_at"],
    key: ["id"],
  },
  /**
   * アカウントの完全削除の台帳（Phase D ／ R4）。
   * **入れるのは、その人の内部番号と、消した日時だけ。** メールアドレス・本文は入れない。
   * 古いバックアップから戻したとき、その人を復活させないため。
   * 38日（ACCOUNT_LEDGER_DAYS）を過ぎた行は、backup:cleanup で消す。
   * 完全削除のあと、ほかの台帳からその人の行は消し、この1行だけがその人を守る。
   */
  accountDeletions: {
    file: "account-deletions.jsonl",
    source: "（npm run account:delete が、消す前に書く）",
    fields: ["user_id", "deleted_at"],
    key: ["user_id"],
  },
} as const;

/** 運営バックアップを残す日数（Phase D ／ D-4）。これを過ぎたものは backup:cleanup の候補 */
export const BACKUP_RETENTION_DAYS = 30;

/**
 * アカウントの完全削除の台帳を残す日数（Phase D ／ N-4）。
 * 運営バックアップ最大30日 ＋ Supabase の物理バックアップ7日 ＋ 余裕1日。
 * この間は、その人を含む古いバックアップが残りうるので、戻したときに除くために要る。
 */
export const ACCOUNT_LEDGER_DAYS = 38;

/**
 * 台帳の書き方の版。読み書きの決まりを変えたら上げる。
 *   1 … Phase 4A（削除台帳・変更台帳）
 *   2 … Phase C（変更台帳の「削除済み」、会話の削除の台帳、［残さない］の台帳）
 * 版1の行も、そのまま読める（「削除済み」の欄が無い行は、削除台帳と突き合わせて判断する）。
 */
export const LEDGER_FORMAT_VERSION = 2;

/**
 * バックアップの書き方の版。
 *   1 … Phase 4A
 *   2 … Phase D（目録に向き先 target＝開発用／本番・名前・場所 を書く）
 */
export const BACKUP_FORMAT_VERSION = 2;

/** 隔離した復元先のスキーマ名（この名前の場所へ戻す。本番の場所は触らない） */
export const RESTORE_SCHEMA = "restore";

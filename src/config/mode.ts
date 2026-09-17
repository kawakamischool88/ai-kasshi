/**
 * 復元モード（Phase 4A）。
 *
 * 【何のためか】
 * 古いバックアップから戻した直後の環境は、まだ安全とは限らない。
 *   ・そのあと本人が消した内容が、まだ残っているかもしれない
 *   ・処理の途中で止まった状態が残っているかもしれない
 * この状態で勝手にAIが動くと、**消したはずの内容を使った返事が作られる**。
 *
 * そこで、復元した環境は最初から「止まった状態」にしておく。
 * 確認がぜんぶ終わるまで、誰も使えないし、有料のAI処理も一切走らない。
 *
 * 【使い方】
 * 復元先の環境で、環境変数に次を入れる。
 *   AI_KASSHI_MODE=restore
 *
 * 入っていなければ、これまで通りの動き。
 * **止めるほうを初期値にはしない**（ふだんの環境が誤って止まると困るため）。
 */

export type AppMode = "normal" | "restore";

export function appMode(): AppMode {
  return process.env.AI_KASSHI_MODE === "restore" ? "restore" : "normal";
}

/**
 * 復元した直後の環境か。
 *
 * true のあいだは、
 *   ・利用者は画面を開けない（お知らせだけ出る）
 *   ・有料のAI処理は一切走らない
 *   ・止まっていた処理も勝手に再開しない
 */
export function isRestoreMode(): boolean {
  return appMode() === "restore";
}

/** 復元中に利用者へ見せるお知らせ */
export const RESTORE_NOTICE = {
  title: "いま点検しています",
  body: "データの復旧作業をしています。終わるまでお待ちください。この間は、会話や記憶の内容は変わりません。",
} as const;

/** 復元中でも通ってよい道（お知らせの画面そのものと、画面の部品） */
export const RESTORE_ALLOWED_PATHS = ["/maintenance"] as const;

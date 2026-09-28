/**
 * ログイン用の6桁コードを、照合の前に整える。
 *
 * 【なぜ要るのか】
 * PCで日本語入力がオンのまま数字を打つと、全角の「１２３４５６」になりやすい。
 * また、メールから貼り付けると空白が紛れ込むことがある。
 * どちらも本人には違いが見えないので、こちらで受け止める。
 *
 * 【受け付ける範囲を広げすぎない】
 * 整えるのは「全角の数字」と「空白」だけ。
 *   ・Unicode の NFKC 正規化は使わない
 *     （丸数字①や上付き数字²まで数字に変わり、頼んでいない入力まで通るため）
 *   ・ハイフンは取り除かない（メールのコードに入らない）
 *   ・7桁以上を6桁に切り詰めない（打ち間違いを黙って通さない）
 *   ・英字・記号は取り除かない（従来どおり拒否する）
 *
 * この関数は画面にもDBにもつながらないので、テストから直接呼べる。
 */

/** 全角の数字（U+FF10〜FF19） */
const FULLWIDTH_DIGITS = /[０-９]/g;

/**
 * 取り除く空白。
 *   \s … 半角スペース・全角スペース（U+3000）・タブ・改行・ノーブレークスペース 等
 *   U+200B〜U+200D … ゼロ幅の文字（メールからの貼り付けで紛れ込むことがある）
 *   U+FEFF … ゼロ幅のノーブレークスペース
 */
const SPACES = /[\s​-‍﻿]/g;

/** 入力されたコードを整える。6桁の数字にならなければ null を返す */
export function normalizeOtp(input: string): string | null {
  const halfWidth = input.replace(FULLWIDTH_DIGITS, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0),
  );
  const compact = halfWidth.replace(SPACES, "");
  return /^[0-9]{6}$/.test(compact) ? compact : null;
}

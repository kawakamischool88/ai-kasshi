/**
 * 画面を移るあいだの表示。
 *
 * 【なぜ要るのか】
 * 次の画面（会話・記憶・出典の読み込み）ができるまで、いまの画面がそのまま残ると、
 * 「押せていない」と思ってもう一度押したり、別のところを押したりしてしまう。
 *
 * Next.js の仕組みで、画面を移るときに自動で出る。
 * ここに置くと、すべての画面の移動に効く（ボタンごとに作らなくてよい）。
 * 画面の中の処理（送信・残す等）のあとの更新では出ない（同じ画面のままのため）。
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <p role="status" className="m-0 mt-8 text-xl">
        読み込んでいます…
      </p>
    </main>
  );
}

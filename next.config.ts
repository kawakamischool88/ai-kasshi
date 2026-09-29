import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    /* 開発サーバー（next dev）は既定で、Server Action を呼ぶたびに
       その引数を端末へ表示する。引数には本人の発言の全文が入るため、
       開発用のAIツールなどが端末を読んだときに会話本文が渡ってしまう。
       これを止める。

       ・表示だけの設定で、Server Action の動きは変わらない
       ・この表示はもともと開発のときだけ動くもので、本番（Vercel）には影響しない
       ・ほかのログ（アクセスの記録など）は今まで通り出る */
    serverFunctions: false,
  },
};

export default nextConfig;

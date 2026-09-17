<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AIカッシー（BEYOND 専用AI 実証実験 #001）開発ルール

このリポジトリは合同会社BEYONDの「本人専用AI基盤」の最初の実証（AIカッシー Ver.0.1）。
運営者＝川上武則（たけ）。利用者は60代後半で、PC / iPad から主に音声入力で使う。

## 絶対に守ること

1. **アプリ本体（`src/`）から service_role キーを使わない。** 使ってよいのは `scripts/` と `tests/` だけ。
2. **行の持ち主（user_id）は `auth.getUser()` から決める。** フォームやリクエストで渡された user_id は信用しない。
3. **新しいテーブルは必ず RLS を有効にし、`auth.uid() = <持ち主列>` の select / insert / update / delete ポリシーを付ける。** `supabase/migrations/20260917000001_chat.sql` がひな形。
4. **新しいテーブルには GRANT も必ず書く。** この Supabase では `authenticated` にも `service_role` にも権限が自動で付かない。付け忘れると `42501 permission denied` になる。`anon` には何も与えない。
5. **DB の変更は必ず `supabase/migrations/` の SQL ファイルで行う。** ダッシュボードの SQL Editor で直接変えない。
6. **モデル名・単価・上限は `src/config/ai.ts` だけに書く。** 他の場所に書かない。原価の掛け算は `src/lib/ai/cost.ts` の `estimateCostUsd` だけで行う。
7. **AI の呼び出しは `src/lib/ai/anthropic.ts` に閉じ込める。** 画面やサーバーアクションから SDK を直接触らない。
8. **本人（柏村さん）の実データを使わない。** 開発・テストは架空ユーザー（`kasshi-test-a/b@example.com`）と川上さんのアドレスだけ。
9. **既存事業（DAIBUTSU・大仏ノート・KSJ系）の Supabase・Vercel・リポジトリ・APIキーに触れない。** AIカッシー専用の APIキーを使う。
10. `.env.local` / `.env.test.local` は commit しない（`.gitignore` 済み）。
11. **秘密の値（APIキー・パスワード）を画面や出力に出さない。** 確認は「形式・文字数・ハッシュ比較・応答コード」で行う（下記「鍵の扱い」）。
12. **どちらの発言かは、色だけで区別しない。** 位置・形・塗りの3つで示す（`src/app/c/[id]/Chat.tsx` の `Bubble`）。

## 鍵の扱い（2026-09-17 確定）

事故が起きたため、ここは特に厳しく運用する。

### 置いてよい場所

| 鍵 | `.env.local`<br>（アプリ本体） | `.env.test.local`<br>（テスト・スクリプト） | **Vercel** |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ○ | ○（`SUPABASE_URL`） | ○ |
| Supabase **Publishable** key | ○ | ○（`SUPABASE_ANON_KEY`） | ○ |
| Supabase **Secret** key | **×** | ○（`SUPABASE_SERVICE_ROLE_KEY`） | **×** |
| `ANTHROPIC_API_KEY` | ○ | × | ○ |
| `SEED_TARGET` / テスト用パスワード | × | ○ | **×** |
| `AI_MONTHLY_WARNING_USD` / `AI_MONTHLY_STOP_USD` | 任意 | × | 任意 |

**Vercel に置いてよいのは、この表で○が付いた3〜5項目だけ。**
`.env.test.local` の中身を Vercel へ一括で取り込まないこと。

### やってはいけないこと

- **`vercel env pull` を使わない。** 手元の `.env.local` が Vercel の内容で上書きされ、
  秘密の鍵や `SEED_TARGET=dev` が混ざる。
- **鍵の値が出力されるコマンドを実行しない。**
  例：`supabase projects api-keys` は**鍵の全文を表示する**（実際にこれで事故が起きた）。
  鍵を調べるときは、先頭の形式（`sb_publishable_` / `sb_secret_` / `eyJ`）・文字数・
  ハッシュの一致比較・API の応答コードだけで判断する。
- **旧方式（JWT形式、`eyJ…`）の鍵を使わない。** 2026-09-17 に Supabase 側で無効化済み。
  新方式（`sb_publishable_` / `sb_secret_`）は**秘密の鍵だけを単独で回転・無効化できる**。
  本番用 Supabase を作るときも、最初から新方式だけを使う。
- **`SEED_TARGET` を本番環境に置かない。** これは「dev のときだけ実行してよい」という
  安全装置そのもの。本番側に `dev` があると意味が反転する。

### 鍵が漏れたときの手順

1. 手元の設定ファイルを新しい鍵に差し替える
2. **Vercel の環境変数も新しい鍵に更新して Redeploy**（ここを飛ばすと次で本番が止まる）
3. 動作確認（テスト一式＋本番URLでのログイン・会話）
4. **その後に**古い鍵を無効化する
5. 無効化された鍵で API を呼び、拒否されること（HTTP 401）を確かめる

## 技術スタック

- Next.js 16（App Router、`src/` 配下、`proxy.ts` が旧 middleware）
- TypeScript / Tailwind CSS v4（設定は `globals.css` の `@theme`）
- Supabase（Auth：メールの6桁コード・招待制 / Postgres + RLS）
- Supabase CLI（`npx supabase ...`、devDependency）
- Anthropic SDK（`@anthropic-ai/sdk`）／モデルは `claude-sonnet-5`
- vitest（`tests/`）

## ハマりどころ（実際に起きたこと）

- `[auth.email] enable_signup = false` は「メールでのログイン自体」を止める。招待制は `[auth] enable_signup = false` だけで行う。
- 新しいテーブルは `authenticated` にも `service_role` にも権限が自動で付かない（上記4）。
- 架空ユーザー（`@example.com`）には Supabase がメールを送らない。画面のログインを試すときは `npm run dev:otp` でコードを取り出す。
- Docker が入っていないため `supabase start` / `db dump` は使えない。確認は開発用のクラウドで行う。
- 認証 Cookie は `src/lib/supabase/cookies.ts` で90日に縮めている（ライブラリ既定は400日）。短い Cookie を伸ばさないよう、上限を超えるものだけ縮める作りにしてある。
- **本番（Vercel）のサーバーは世界標準時で動く。** 日時を画面に出すときは必ず
  `src/lib/time.ts` の `formatDateTimeJst` / `formatDateJst` を使う。
  時間帯を指定せずに `toLocaleString` を書くと、本番だけ9時間ずれる（実際に起きた）。
  手元のパソコンは日本時間なので、開発中は気づけない。
- **連打による二重送信は、保存側の一意制約だけでは止められない。** 送信IDが別々になるため。
  画面側で即座に鍵をかける（`Chat.tsx` の `sendingRef`）。
- **React は「無効なボタン」のクリックを内部で無視する。** DOM の `disabled` を外しても
  ハンドラは呼ばれない。サーバー側の遮断を試すときは、画面側の制限を一時的に外して確認する。

## よく使うコマンド

| やること | コマンド |
| --- | --- |
| 開発サーバー | `npm run dev` |
| DB 変更を開発用 Supabase へ反映 | `npm run db:push` |
| Supabase の設定（招待制・メール文面）を反映 | `npm run config:push` |
| 架空ユーザー A・B を作る | `npm run seed` |
| テスト（越境アクセス・原価計算） | `npm test` |
| ログインを許可する人を登録 | `npm run invite -- メールアドレス` |
| 架空ユーザーの6桁コードを取り出す | `npm run dev:otp -- kasshi-test-a@example.com` |
| 架空ユーザーのテストデータを消す | `npm run reset:test` |

## Phase の範囲（勝手に次へ進まない）

- Phase 1（完了）：土台。認証・最小画面・RLS・越境テスト。
- Phase 2（完了）：文字チャット・会話履歴・AI利用量と推定原価・原価の安全装置・Cookie 90日。
- **Phase 2 では作らなかった**：長期記憶・記憶候補・記憶検索・ベクトル検索・PDF・アプリ内マイク・
  リアルタイム音声・管理画面・複数AI Provider・自動モデル切替・柏村さん本人の実データ。
- Phase 3（未着手）：長期記憶。**指示があるまで着手しない。**

## 柏村さんが使い始める前に必ず済ませること

1. **独自SMTP の設定**（Resend + `ai@beyond-towada.co.jp`）。
   Supabase 標準のメール送信は、プロジェクトのチームメンバー宛てにしか届かない。
2. **`/cost` を非表示にするか、管理者だけに限る。** いまは誰でも開ける。
3. **データの取り扱いと同意の文面**を用意する。

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
- Phase 2（現在）：文字チャット・会話履歴・AI利用量と推定原価・原価の安全装置・Cookie 90日。
- **Phase 2 では作らない**：長期記憶・記憶候補・記憶検索・ベクトル検索・PDF・アプリ内マイク・
  リアルタイム音声・管理画面・複数AI Provider・自動モデル切替・柏村さん本人の実データ。
- Phase 3（未着手）：長期記憶。**指示があるまで着手しない。**

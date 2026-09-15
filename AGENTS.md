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
3. **新しいテーブルは必ず RLS を有効にし、`auth.uid() = <持ち主列>` の select / insert / update / delete ポリシーを付ける。** `supabase/migrations/20260915000001_profiles.sql` がひな形。
4. **DB の変更は必ず `supabase/migrations/` の SQL ファイルで行う。** ダッシュボードの SQL Editor で直接変えない。
5. **本人の実データを使わない。** 開発・テストは架空ユーザー（`kasshi-test-a/b@example.com`）だけ。
6. **既存事業（DAIBUTSU・大仏ノート・KSJ系）の Supabase・Vercel・リポジトリに触れない。** このプロジェクトは完全に独立している。
7. `.env.local` / `.env.test.local` は commit しない（`.gitignore` 済み）。

## 技術スタック

- Next.js 16（App Router、`src/` 配下、`proxy.ts` が旧 middleware）
- TypeScript / Tailwind CSS v4（設定は `globals.css` の `@theme`）
- Supabase（Auth：メールの6桁コード・招待制 / Postgres + RLS）
- Supabase CLI（`npx supabase ...`、devDependency）
- vitest（`tests/`）

## よく使うコマンド

| やること | コマンド |
| --- | --- |
| 開発サーバー | `npm run dev` |
| DB 変更を開発用 Supabase へ反映 | `npm run db:push` |
| Supabase の設定（招待制・メール文面）を反映 | `npm run config:push` |
| 架空ユーザー A・B を作る | `npm run seed` |
| 越境アクセスの自動テスト | `npm test` |
| ログインを許可する人を登録 | `npm run invite -- メールアドレス` |

## Phase の範囲（勝手に次へ進まない）

- Phase 1（現在）：土台のみ。認証・最小画面・RLS・越境テスト。
- AI会話・長期記憶・記憶候補・音声ファイル処理・PDF・原価計測・管理画面は **Phase 1 では作らない**。

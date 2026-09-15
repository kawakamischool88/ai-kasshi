# AIカッシー Ver.0.1（BEYOND 専用AI 実証実験 #001）

Phase 1：土台（認証・最小画面・ユーザー分離）。AI会話はまだ入っていません。

## 1. 最初に一度だけやること（川上さんの作業）

### 1-1. 開発用 Supabase プロジェクトを作る

1. https://supabase.com/dashboard を開く
2. 「New project」→ 名前 `ai-kasshi-dev`、リージョン `Northeast Asia (Tokyo)`、プラン **Free**
3. Database Password は Supabase に生成させ、**パスワード管理ソフト等に控える**（後で使う）
4. 作成後、左メニュー「Project Settings」→「API Keys」を開く

### 1-2. 鍵をファイルに写す

プロジェクト直下に2つのファイルを作る（`.env.example` を見本に）。

- `.env.local` … `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `.env.test.local` … `SEED_TARGET=dev`、`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`TEST_USER_A_PASSWORD`、`TEST_USER_B_PASSWORD`

どちらも git には入りません（`.gitignore` 済み）。

### 1-3. Supabase CLI をこのプロジェクトにつなぐ

ターミナルでプロジェクトフォルダに入り、次を順に実行する。

```bash
npx supabase login
```
（ブラウザが開くので Supabase にログインして許可する）

```bash
npx supabase link --project-ref （プロジェクトの Reference ID）
```
（Database Password を聞かれるので 1-1 で控えたものを入力。Reference ID は Project Settings → General にある）

### 1-4. DB と設定を反映する

```bash
npm run db:push
```
（`supabase/migrations/` の SQL が開発用 Supabase に適用される）

```bash
npm run config:push
```
（新規登録の停止・6桁コードのメール文面が反映される。差分が表示されるので `y` で確定）

### 1-5. 架空ユーザーを作り、越境テストを回す

```bash
npm run seed
```

```bash
npm test
```
すべて緑（passed）になれば、ユーザー分離は合格。

### 1-6. 自分のメールアドレスを招待してログインを試す

```bash
npm run invite -- 自分のメールアドレス
```

```bash
npm run dev
```
http://localhost:3000 を開き、メールアドレス → 届いた6桁コード でログインできることを確認。

## 2. Vercel へ載せる

1. GitHub に空のリポジトリ `ai-kasshi` を作り、このフォルダを push
2. Vercel で「Add New → Project」→ `ai-kasshi` を選ぶ
3. Environment Variables に `.env.local` の2つ（`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`）を登録
4. Deploy

## 3. 仕組みの要点

- ログイン：メールに届く6桁コード。**招待した人しか入れない**（Supabase 側で新規登録を停止）
- ユーザー分離：全テーブルで RLS。行の持ち主は `auth.uid()`（ログイン情報）から決まり、画面から渡された id は使わない
- service_role を使うのは `scripts/`（架空ユーザー作成・招待）と `tests/` だけ。**アプリ本体では使わない**
- DB の変更は必ず `supabase/migrations/` に SQL ファイルを足して `npm run db:push`

## 4. フォルダ

```
src/app/            画面（/login と /）と Server Action
src/lib/supabase/   Supabase 接続（client / server / middleware）
src/proxy.ts        ログイン確認（Next.js 16 の middleware）
supabase/           CLI 設定・migrations・メール文面
scripts/            架空ユーザー作成・招待（service_role 使用）
tests/              越境アクセスの自動テスト
```

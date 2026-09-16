# AIカッシー Ver.0.1（BEYOND 専用AI 実証実験 #001）

Phase 2：AIカッシーとの文字チャット・会話履歴・AI利用量と推定原価。
長期記憶はまだありません（Phase 3）。

## 0. AIのAPIキーを入れる（Phase 2 で追加）

1. https://console.anthropic.com/settings/keys を開く
2. **Create Key** → 名前は `ai-kasshi`（AIカッシー専用。大仏ノート等のキーは使わない）
3. 表示されたキーをコピー（この画面を閉じると二度と見られません）
4. `.env.local` に次の行を足す

```
ANTHROPIC_API_KEY=（コピーしたキー）
```

5. Vercel にも同じものを登録する
   （Project `ai-kasshi` → Settings → Environment Variables → Key: `ANTHROPIC_API_KEY`）

キーが未設定のときは、画面に「AIの設定がまだ済んでいません」と出て、
会話の保存・閲覧などお金のかからない機能はそのまま使えます。

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

## 2. Vercel（設定済み）

- 本番 URL：https://ai-kasshi.vercel.app
- GitHub `kawakamischool88/ai-kasshi` の `main` へ push すると自動でデプロイされる
- 環境変数は `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` の2つだけ（service_role は登録しない）
- push は川上さんがターミナルで行う：`git push origin main`

## 2-1. 架空ユーザーで画面のログインを試すとき

架空ユーザー（`@example.com`）にはメールが届かないので、コードをスクリプトで取り出す。

```bash
npm run dev:otp -- kasshi-test-a@example.com
```

ログイン画面でメールアドレスを入れ、「すでにコードを持っている」→ 表示された6桁を入力。
（`@example.com` 以外のアドレスには使えない）

## 3. 仕組みの要点

- ログイン：メールに届く6桁コード。**招待した人しか入れない**（Supabase 側で新規登録を停止）
- ユーザー分離：全テーブルで RLS。行の持ち主は `auth.uid()`（ログイン情報）から決まり、画面から渡された id は使わない
- service_role を使うのは `scripts/`（架空ユーザー作成・招待・データ掃除）と `tests/` だけ。**アプリ本体では使わない**
- DB の変更は必ず `supabase/migrations/` に SQL ファイルを足して `npm run db:push`
- ログイン状態の Cookie は90日（`src/lib/supabase/cookies.ts`）

### AI まわり（Phase 2）

- モデル・単価・上限は **`src/config/ai.ts` の1箇所だけ**。値上げやモデル変更はここを直して push するだけ（DBの作り替えは不要）
- 原価の計算は **`src/lib/ai/cost.ts` の `estimateCostUsd` だけ**
- AI の呼び出しは **`src/lib/ai/anthropic.ts` に閉じ込める**
- AI へ渡すのは「基本指示」と「その会話の直近20件」だけ。過去の全会話は送らない
- 原価の安全装置：月ごとに 警告値（$15）と停止値（$40）。停止中でも、ログイン・過去の会話の閲覧・ログアウトはできる
- 利用状況の確認：`/cost`（開発確認用）

## 4. フォルダ

```
src/app/            画面と Server Action
  /login            ログイン
  /                 会話の一覧
  /c/[id]           会話の画面
  /cost             利用状況（開発確認用）
src/config/ai.ts    モデル・単価・上限・安全装置  ← AIの設定はここだけ
src/config/prompt.ts AIカッシーの基本指示
src/lib/ai/         AI呼び出し・原価計算・安全装置
src/lib/supabase/   Supabase 接続（client / server / middleware / cookies）
src/proxy.ts        ログイン確認（Next.js 16 の middleware）
supabase/           CLI 設定・migrations・メール文面
scripts/            架空ユーザー作成・招待・掃除（service_role 使用）
tests/              越境アクセス・原価計算の自動テスト
```

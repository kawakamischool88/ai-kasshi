import { LoginForm } from "./LoginForm";

/**
 * ログイン画面（招待制）。
 * 事前に登録されたメールアドレスにだけ、6桁のコードを送る。
 */
export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-5 py-12">
      <h1 className="text-2xl font-bold tracking-wide">AIカッシー</h1>
      <p className="mt-2 text-sm text-neutral-600">BEYOND 専用AI 実証実験 #001</p>
      <LoginForm />
    </main>
  );
}

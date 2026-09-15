"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Step = "email" | "code";

/**
 * メールアドレス → 6桁コード の2段階でログインする。
 *
 * 招待制：shouldCreateUser を false にしているので、
 * 登録されていないメールアドレスには新しいアカウントが作られない。
 * （Supabase 側でも新規登録を止めているため二重に守られている）
 */
export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });

    setBusy(false);
    if (error) {
      // 未登録・送信制限など。理由を細かく出さない（登録の有無を推測されないため）
      setMessage("コードを送れませんでした。登録されたメールアドレスか、しばらく待ってからお試しください。");
      return;
    }
    setStep("code");
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });

    setBusy(false);
    if (error) {
      setMessage("コードが違うか、期限が切れています。もう一度お試しください。");
      return;
    }
    // Cookie が更新されたので、サーバー側の判定を効かせるため refresh する
    router.replace("/");
    router.refresh();
  }

  if (step === "email") {
    return (
      <form onSubmit={sendCode} className="mt-10 flex flex-col gap-5">
        <label className="flex flex-col gap-2">
          <span className="font-bold">メールアドレス</span>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            className="min-h-14 rounded border border-line bg-white px-4"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="min-h-14 rounded bg-accent px-6 text-lg font-bold text-white disabled:opacity-60"
        >
          {busy ? "送っています…" : "ログイン用のコードを送る"}
        </button>
        {message && (
          <p role="alert" className="border-l-4 border-red-700 bg-white px-4 py-3 text-base">
            {message}
          </p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={verifyCode} className="mt-10 flex flex-col gap-5">
      <p>
        <span className="font-bold">{email}</span> に6桁のコードを送りました。
        メールを開いて、コードを入力してください。
      </p>
      <label className="flex flex-col gap-2">
        <span className="font-bold">6桁のコード</span>
        <input
          type="text"
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          className="min-h-14 rounded border border-line bg-white px-4 text-2xl tracking-[0.3em]"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="min-h-14 rounded bg-accent px-6 text-lg font-bold text-white disabled:opacity-60"
      >
        {busy ? "確認しています…" : "ログインする"}
      </button>
      <button
        type="button"
        onClick={() => {
          setStep("email");
          setCode("");
          setMessage(null);
        }}
        className="min-h-12 text-base underline underline-offset-4"
      >
        メールアドレスを入れ直す
      </button>
      {message && (
        <p role="alert" className="border-l-4 border-red-700 bg-white px-4 py-3 text-base">
          {message}
        </p>
      )}
    </form>
  );
}

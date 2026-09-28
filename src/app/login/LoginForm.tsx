"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizeOtp } from "@/lib/otp";

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
    setMessage(null);

    /* 全角の数字・空白を整えてから照合する。
       6桁の数字にならなければ、照合（Supabase への問い合わせ）はしない。
       入力中には書き換えない（日本語入力の途中で書き換えると入力が壊れるため）。 */
    const token = normalizeOtp(code);
    if (!token) {
      setMessage("メールに書かれている6桁の数字を入れてください。");
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
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
        {/* 既にコードが届いている（画面を閉じてしまった等）ときは、送り直さずに入力へ進める */}
        <button
          type="button"
          disabled={busy || !email.trim()}
          onClick={() => {
            setMessage(null);
            setStep("code");
          }}
          className="min-h-12 text-base underline underline-offset-4 disabled:opacity-40"
        >
          すでにコードを持っている
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
          /* pattern は付けない。ブラウザが送信の前に判定するため、
             全角の数字がこちらの処理に届く前に止められてしまう（判定は normalizeOtp で行う）。
             maxLength は、空白入りで貼り付けても途中で切れないよう、6より広くしてある。 */
          maxLength={20}
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

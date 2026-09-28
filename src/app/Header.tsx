import Link from "next/link";
import { signOut } from "./actions";
import { SubmitOnce } from "./SubmitOnce";

/** 全画面共通の見出し。戻り先があるときは backHref を渡す */
export function Header({ backHref }: { backHref?: string }) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line pb-4">
      {backHref ? (
        <Link
          href={backHref}
          className="flex min-h-12 items-center rounded border border-line bg-white px-5 text-base no-underline"
        >
          ← 会話の一覧
        </Link>
      ) : (
        <h1 className="text-2xl font-bold tracking-wide">AIカッシー</h1>
      )}

      {/* 押した瞬間に鍵をかけ、「ログアウトしています…」を出す */}
      <SubmitOnce
        action={signOut}
        label="ログアウト"
        pendingLabel="ログアウトしています…"
        className="min-h-12 rounded border border-line bg-white px-5 text-base hover:bg-neutral-100 disabled:opacity-60"
      />
    </header>
  );
}

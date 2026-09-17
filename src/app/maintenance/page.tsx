import { RESTORE_NOTICE } from "@/config/mode";

/**
 * 復元中のお知らせ（Phase 4A）。
 *
 * 復元した直後の環境では、どの道を開いてもこの画面になる。
 * 点検がぜんぶ終わるまで、会話も記憶も触れない。
 */
export default function MaintenancePage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-16">
      <h1 className="m-0 text-2xl font-bold">AIカッシー</h1>
      <p className="m-0 mt-1 text-sm text-neutral-600">BEYOND 専用AI 実証実験 #001</p>

      <section className="mt-12 rounded-2xl border-2 border-line bg-white px-6 py-8">
        <h2 className="m-0 text-xl font-bold">{RESTORE_NOTICE.title}</h2>
        <p className="m-0 mt-4 text-lg leading-relaxed">{RESTORE_NOTICE.body}</p>
      </section>
    </main>
  );
}

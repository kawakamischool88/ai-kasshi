import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIカッシー",
  description: "BEYOND 専用AI 実証実験 #001（Ver.0.1）",
  // 実証実験の画面なので検索エンジンには載せない
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // iPad で入力欄をタップしたときの勝手な拡大を防ぐ（文字は最初から大きくしてある）
  maximumScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

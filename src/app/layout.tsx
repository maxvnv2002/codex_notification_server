import type { ReactNode } from "react";

export const metadata = {
  title: "Codex Telegram Notifier",
  description: "API-only backend for Codex Telegram notifications"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

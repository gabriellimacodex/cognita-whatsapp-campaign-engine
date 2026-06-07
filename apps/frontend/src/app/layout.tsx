import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cognita Campaign Engine",
  description: "Operational cockpit for WhatsApp campaign workflows"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}


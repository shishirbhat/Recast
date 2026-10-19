import type { Metadata } from "next";
import type { ReactNode } from "react";
import { themeBootScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay",
  description: "One project. Any model. Every contributor in sync.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

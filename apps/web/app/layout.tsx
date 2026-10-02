import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = { title: "Recast control center", description: "See and control what Recast knows, where it can place things, and what it did." };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-(--r-pill) focus:bg-raised focus:px-4 focus:py-2">Skip to content</a>
        <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[180px_1fr]">
          <div>
            <p className="mb-4 px-4 text-sm font-semibold tracking-wide">Recast</p>
            <Nav />
            <p className="mt-6 px-4 text-xs text-muted">Demo data. Nothing leaves this device.</p>
          </div>
          <main id="main" tabIndex={-1}>{children}</main>
        </div>
      </body>
    </html>
  );
}

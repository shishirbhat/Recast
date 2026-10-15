import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Recast API", description: "Turn any screen object into a typed, routed action." };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f7f7f5", color: "#1c1d21" }}>{children}</body></html>;
}

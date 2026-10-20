import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CSS } from "@/lib/page-style";
export const metadata: Metadata = { title: "Recast API", description: "Turn any screen object into a typed, routed action." };
// Colours come from the tokens in CSS (light and dark), never from inline styles, which would override the dark theme.
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><style>{CSS}</style></head><body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body></html>;
}

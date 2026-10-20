"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

const items = [["/", "Objects"], ["/relationships", "Relationships"], ["/integrations", "Integrations"], ["/permissions", "Permissions"], ["/agents", "Agents"], ["/approvals", "Approvals"], ["/audit", "Audit chain"], ["/history", "History"], ["/privacy", "Privacy"]] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-1 md:flex-col">
      {items.map(([href, label]) => {
        const on = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={on ? "page" : undefined}
            className="relative rounded-(--r-pill) px-4 py-1.5 text-sm text-muted aria-[current=page]:font-medium aria-[current=page]:text-ink hover:text-ink">
            {on ? <motion.span layoutId="nav-pill" className="absolute inset-0 -z-10 rounded-(--r-pill) bg-accent-soft" transition={{ type: "spring", stiffness: 300, damping: 24, mass: 0.8 }} /> : null}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

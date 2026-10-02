"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

const items = [["/", "Objects"], ["/relationships", "Relationships"], ["/integrations", "Integrations"], ["/permissions", "Permissions"], ["/history", "History"], ["/privacy", "Privacy"]] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-1 md:flex-col">
      {items.map(([href, label]) => {
        const on = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={on ? "page" : undefined}
            className="relative rounded-(--r-pill) px-4 py-1.5 text-sm text-muted aria-[current=page]:font-medium aria-[current=page]:text-ink hover:text-ink">
            {on ? <motion.span layoutId="nav-pill" className="absolute inset-0 -z-10 rounded-(--r-pill) bg-accent-soft" transition={{ duration: 0.16, ease: [0.2, 0.7, 0.1, 1] }} /> : null}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { api, ApiError } from "@/lib/api";
import { Mark } from "@/components/ui";

/**
 * The invite token travels in the URL fragment, which browsers never send to servers or link previewers,
 * so it is only redeemed when a person actually opens the page.
 */
export default function Join() {
  const [state, setState] = useState<{ kind: "working" } | { kind: "error"; message: string } | { kind: "done"; name: string }>({ kind: "working" });

  useEffect(() => {
    const token = location.hash.slice(1);
    history.replaceState(null, "", "/join");
    if (!token) return setState({ kind: "error", message: "This link has no invite in it." });
    api<{ member: { name: string } }>("POST", "/join", { token })
      .then((r) => {
        setState({ kind: "done", name: r.member.name });
        setTimeout(() => location.replace("/"), 900);
      })
      .catch((e) => setState({ kind: "error", message: e instanceof ApiError ? e.message : String(e) }));
  }, []);

  return (
    <div className="dot-grid relative z-10 grid min-h-screen place-items-center bg-chrome p-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full ticks max-w-md border border-rule bg-panel p-10">
        <Mark size={32} />
        {state.kind === "working" && (
          <h1 className="mt-6 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
            Joining <span className="text-accent-ink">the project…</span>
          </h1>
        )}
        {state.kind === "done" && (
          <h1 className="mt-6 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
            Welcome, <span className="text-accent-ink">{state.name}.</span>
          </h1>
        )}
        {state.kind === "error" && (
          <>
            <h1 className="mt-6 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
              That link <span className="text-danger">didn&apos;t work.</span>
            </h1>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-2">{state.message}</p>
          </>
        )}
        <p className="micro mt-8 text-faint">One project · any model · in sync</p>
      </motion.div>
    </div>
  );
}

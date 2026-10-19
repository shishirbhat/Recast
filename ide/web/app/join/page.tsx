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
    <div className="relative z-10 grid min-h-screen place-items-center p-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md rounded-[28px] border border-rule bg-panel p-10 shadow-panel">
        <Mark size={32} />
        {state.kind === "working" && (
          <h1 className="mt-6 text-[40px] leading-[1.02]">
            Joining <span className="serif-em text-accent-ink">the project…</span>
          </h1>
        )}
        {state.kind === "done" && (
          <h1 className="mt-6 text-[40px] leading-[1.02]">
            Welcome, <span className="serif-em text-accent-ink">{state.name}.</span>
          </h1>
        )}
        {state.kind === "error" && (
          <>
            <h1 className="mt-6 text-[40px] leading-[1.02]">
              That link <span className="serif-em text-danger">didn&apos;t work.</span>
            </h1>
            <p className="mt-4 text-[14px] leading-relaxed text-ink-2">{state.message}</p>
          </>
        )}
        <p className="mt-8 text-[12px] text-faint">One project. Any model. Every contributor in sync.</p>
      </motion.div>
    </div>
  );
}

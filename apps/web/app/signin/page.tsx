import { redirect } from "next/navigation";
import { signIn } from "@/app/auth-actions";
import { authMode, getSession } from "@/lib/auth";
import { safeNext } from "@/lib/session";

export const dynamic = "force-dynamic";
const MESSAGES: Record<string, string> = {
  invalid: "That email and password don't match an account.",
  missing: "Enter your email and password.",
  locked: "Too many tries. Wait 15 minutes, then try again.",
  unavailable: "Sign-in is unavailable right now. Try again shortly.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  if (authMode() === "demo" || (await getSession())) redirect(safeNext(next));
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="text-[40px]">Sign in</h1>
      <p className="mt-2 text-muted">To see and control what Recast knows for you.</p>
      {error ? <p id="err" role="alert" className="mt-6 rounded-(--r-input) border border-danger-ink px-4 py-3 text-danger-ink">{MESSAGES[error] ?? MESSAGES.invalid}</p> : null}
      <form action={signIn} className="mt-6 grid gap-4">
        <input type="hidden" name="next" value={safeNext(next)} />
        <label className="grid gap-1.5 text-sm font-medium">Email
          <input name="email" type="email" autoComplete="username" required className="h-10 rounded-(--r-input) border border-line bg-raised px-3 font-normal" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">Password
          <input name="password" type="password" autoComplete="current-password" required className="h-10 rounded-(--r-input) border border-line bg-raised px-3 font-normal" />
        </label>
        <button type="submit" className="mt-2 h-10 rounded-(--r-pill) bg-accent font-medium text-on-accent">Sign in</button>
      </form>
    </div>
  );
}

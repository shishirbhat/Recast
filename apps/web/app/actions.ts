"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepo } from "@/lib/repo";
import { runtimeFor } from "@/lib/runtime";
import { requireSession } from "@/lib/auth";

export async function deleteObject(fd: FormData) { await (await getRepo()).deleteObject(String(fd.get("id"))); revalidatePath("/", "layout"); }
export async function revokeGrant(fd: FormData) { await (await getRepo()).revokeGrant(String(fd.get("id"))); revalidatePath("/", "layout"); }
export async function setIntegration(fd: FormData) {
  const repo = await getRepo(); const dest = String(fd.get("destination"));
  const cur = (await repo.listIntegrations()).find((i) => i.destination === dest); if (!cur) return;
  await repo.setIntegration({ ...cur, enabled: fd.get("enabled") === "true" }); revalidatePath("/", "layout");
}
/** Requires the exact word DELETE. Anything else changes nothing. */
export async function deleteAll(fd: FormData) {
  if (String(fd.get("confirm")).trim() !== "DELETE") redirect("/privacy?error=confirm");
  await (await getRepo()).deleteAll(); revalidatePath("/", "layout"); redirect("/privacy?deleted=1");
}

/** A person decides what an agent asked to do. `by` is who is signed in (the demo records "demo-user"). */
export async function decideApproval(fd: FormData) {
  const session = await requireSession();
  const id = String(fd.get("id")); const approve = fd.get("decision") === "approve";
  const by = session.via === "demo" ? "demo-user" : `${session.email || session.userId} (${session.via})`;
  const access = await runtimeFor(session); if (!access.ok) redirect("/approvals");
  try { await access.runtime.decide(id, approve, by); } catch { redirect("/approvals?error=gone"); }
  revalidatePath("/", "layout"); redirect(`/approvals?done=${approve ? "approved" : "rejected"}`);
}

/** Stops a Space at once and for good. Anyone signed in to the workspace can stop one; nobody can restart it. */
export async function stopSpace(fd: FormData) {
  const session = await requireSession();
  const by = session.via === "demo" ? "demo-user" : `${session.email || session.userId} (${session.via})`;
  const access = await runtimeFor(session); if (!access.ok) redirect("/agents");
  try { await access.runtime.stopSpace(String(fd.get("id")), by); } catch { redirect("/agents?error=gone"); }
  revalidatePath("/", "layout"); redirect("/agents?done=stopped");
}

"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepo } from "@/lib/repo";
import { getRuntime } from "@/lib/runtime";

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

/** A person decides what an agent asked to do. `by` is who is signed in; the demo has no sign-in, so it says so. */
export async function decideApproval(fd: FormData) {
  const id = String(fd.get("id")); const approve = fd.get("decision") === "approve";
  try { await getRuntime().decide(id, approve, "demo-user"); } catch { redirect("/approvals?error=gone"); }
  revalidatePath("/", "layout"); redirect(`/approvals?done=${approve ? "approved" : "rejected"}`);
}

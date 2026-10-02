"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepo } from "@/lib/repo";

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

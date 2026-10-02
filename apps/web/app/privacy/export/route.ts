import { getRepo } from "@/lib/repo";
export const dynamic = "force-dynamic";
export async function GET() {
  const data = await (await getRepo()).exportAll();
  return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="recast-export.json"' } });
}

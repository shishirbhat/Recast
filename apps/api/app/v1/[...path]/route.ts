import { getApi } from "@/lib/api";
export const dynamic = "force-dynamic";
const handler = async (req: Request) => (await getApi()).handle(req);
export { handler as GET, handler as POST };

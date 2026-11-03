import { referencedFileRequest } from "@/lib/referenced-files.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return referencedFileRequest(request, (await params).id);
}

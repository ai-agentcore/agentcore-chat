import { referencedFileRequest } from "@/lib/referenced-files.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return referencedFileRequest(request, (await params).id, true);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return referencedFileRequest(request, (await params).id, true);
}

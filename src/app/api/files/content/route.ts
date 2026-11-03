import { userFileRequest } from "@/lib/user-files.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const GET = (request: Request) => userFileRequest(request, true);
export const HEAD = (request: Request) => userFileRequest(request, true);

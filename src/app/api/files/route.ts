import { userFileRequest } from "@/lib/user-files.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => userFileRequest(request);

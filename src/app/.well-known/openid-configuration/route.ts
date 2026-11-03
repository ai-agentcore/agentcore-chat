import { appIdentityPublicDocument } from "@/lib/app-identity.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return appIdentityPublicDocument("discovery"); }

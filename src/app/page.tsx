import { ChatApp } from "@/components/chat-app";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser, getSession } from "@/lib/auth.server";

export const dynamic = "force-dynamic";
export default async function Home() {
  const session = await getSession(await headers());
  if (!session) redirect("/login");
  return <ChatApp key={session.user.id} user={await getCurrentUser(session)} />;
}

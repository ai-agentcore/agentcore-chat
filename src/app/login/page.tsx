import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { aliyunEnabled, getSession } from "@/lib/auth.server";
import { AuthForm } from "@/components/auth-form";
import { localAuthRedirect } from "@/lib/auth-origin.server";

export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const requestHeaders = await headers();
  const canonical = localAuthRedirect(requestHeaders.get("host"), process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000");
  if (canonical) redirect(canonical);
  if (await getSession(requestHeaders)) redirect("/");
  const params = await searchParams;
  return <AuthForm aliyunEnabled={aliyunEnabled()} initialError={params.error ? "阿里云登录未完成，请重试，或使用邮箱登录。" : ""} />;
}

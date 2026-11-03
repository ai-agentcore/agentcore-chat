"use client";
import { useState } from "react";
import { ArrowRight, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { authClient, reloadAfterAuth } from "@/lib/auth-client";
import { aliyunLoginError } from "@/lib/auth-errors";
import { BrandMark } from "./brand";
import { frontendConfig } from "@/config/frontend";

export function AuthForm({ aliyunEnabled, initialError = "" }: { aliyunEnabled: boolean; initialError?: string }) {
  const [register, setRegister] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const form = new FormData(event.currentTarget);
    const credentials = { email: String(form.get("email")).trim(), password: String(form.get("password")), callbackURL: "/" };
    try {
      const result = register ? await authClient.signUp.email({ ...credentials, name: String(form.get("name")).trim() }) : await authClient.signIn.email(credentials);
      if (result.error) {
        const code = result.error.code || "";
        setError(code.includes("PASSWORD") && !code.includes("INVALID") ? "密码请使用 10–128 个字符。" : code.includes("ALREADY") ? "该邮箱已注册，请直接登录。" : result.error.status === 429 ? "尝试次数较多，请稍后再试。" : register ? "注册未完成，请检查填写内容后重试。" : "邮箱或密码不正确，请重试。");
      } else { reloadAfterAuth("/"); return; }
    } catch { setError("暂时无法连接，请稍后重试。"); }
    setBusy(false);
  }
  async function loginAliyun() {
    setBusy(true); setError("");
    try {
      const result = await authClient.signIn.social({ provider: "aliyun", callbackURL: "/", errorCallbackURL: "/login?error=aliyun" });
      if (!result.error) return;
      setError(aliyunLoginError(result.error));
    } catch { setError(aliyunLoginError()); }
    setBusy(false);
  }
  return <main className="auth-page">
    <a className="brand auth-brand" href="/login"><BrandMark size={28} /><span>{frontendConfig.brand.name}</span></a>
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-emblem"><BrandMark size={40} /></div>
      <h1 id="auth-title">{register ? frontendConfig.copy.auth.registerTitle : frontendConfig.copy.auth.loginTitle}</h1>
      <p className="auth-subtitle">{register ? frontendConfig.copy.auth.registerSubtitle : frontendConfig.copy.auth.loginSubtitle}</p>
      {/* Retain the OAuth UI for restoration; the server currently disables it. */}
      {aliyunEnabled && <>
      <button className="auth-social" type="button" onClick={loginAliyun} disabled={busy}>
        <span className="aliyun-mark" aria-hidden="true">[<span>−</span>]</span>使用阿里云账号继续
      </button>
      <div className="auth-divider"><span>或使用邮箱</span></div>
      </>}
      <form onSubmit={submit} className="auth-form">
        {register && <label>昵称<input name="name" autoComplete="nickname" required maxLength={80} placeholder="你希望我们怎么称呼你" disabled={busy} /></label>}
        <label>邮箱<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" disabled={busy} /></label>
        <label>密码<span className="auth-password"><input name="password" type={show ? "text" : "password"} autoComplete={register ? "new-password" : "current-password"} required minLength={register ? 10 : undefined} maxLength={128} placeholder={register ? "至少 10 个字符" : "输入你的密码"} disabled={busy} /><button type="button" aria-label={show ? "隐藏密码" : "显示密码"} onClick={() => setShow(!show)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="auth-spinner" size={18} /> : <>{register ? "创建账号" : "登录"}<ArrowRight size={17} /></>}</button>
      </form>
      <p className="auth-switch">{register ? "已经有账号？" : "还没有账号？"}<button type="button" disabled={busy} onClick={() => { setRegister(!register); setError(""); }}>{register ? "登录" : "注册"}</button></p>
    </section>
    <footer className="auth-footer">{frontendConfig.copy.auth.footer}</footer>
  </main>;
}

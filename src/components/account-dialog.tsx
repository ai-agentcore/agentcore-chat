"use client";
import { useState } from "react";
import { authClient, reloadAfterAuth } from "@/lib/auth-client";
import { aliyunAccountTypeLabel, type CurrentUser } from "@/lib/user-profile";
import { Dialog } from "./dialog";

export function AccountDialog({ user, open, onClose, onBeforeSignOut }: { user: CurrentUser; open: boolean; onClose: () => void; onBeforeSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function logout() {
    setBusy(true); setMessage(""); onBeforeSignOut();
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error();
      reloadAfterAuth("/login");
    } catch { setMessage("退出未完成，请重试。"); setBusy(false); }
  }
  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await authClient.changePassword({ currentPassword: String(data.get("currentPassword")), newPassword: String(data.get("newPassword")), revokeOtherSessions: true });
      if (result.error) setMessage("修改失败，请检查当前密码和新密码。");
      else { setMessage("密码已更新，其他设备已退出登录。"); form.reset(); }
    } catch { setMessage("暂时无法连接，请稍后重试。"); }
    setBusy(false);
  }
  return <Dialog open={open} onClose={onClose} title="账号设置">
    <div className="account-profile"><div className="workspace-avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}</strong><p>{user.email || "通过阿里云账号登录"}</p></div></div>
    {user.provider === "aliyun" && <dl className="account-details">
      <div><dt>登录名</dt><dd>{user.aliyun?.loginName || "未提供"}</dd></div>
      <div><dt>账号类型</dt><dd>{aliyunAccountTypeLabel(user.aliyun?.accountType ?? null)}</dd></div>
    </dl>}
    {user.provider === "email" ? <form className="auth-form account-password-form" onSubmit={changePassword}>
      <h3>修改密码</h3>
      <label>当前密码<input name="currentPassword" type="password" autoComplete="current-password" required disabled={busy} /></label>
      <label>新密码<input name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required placeholder="至少 10 个字符" disabled={busy} /></label>
      <button className="secondary-button" disabled={busy}>更新密码</button>
    </form> : <p className="dialog-description">阿里云授权过期后，退出并重新使用阿里云账号登录即可更新授权。</p>}
    {message && <p className="account-message" role="status">{message}</p>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>完成</button><button type="button" className="danger-button" disabled={busy} onClick={logout}>退出登录</button></div>
  </Dialog>;
}

import { useState } from "react";
import { notifyIdentityChanged } from "../hooks";

// Local-dev identity simulation: the worker accepts the x-telegram-user-id
// fallback only when ENVIRONMENT=development AND the request presents
// ADMIN_DEV_AUTH_SECRET via x-dev-auth-secret, so public deployments
// (staging/production) are never affected.
export function TestBanner({ visible }: { visible: boolean }) {
  const [value, setValue] = useState(localStorage.getItem("telegramUserId") || "");
  const [secret, setSecret] = useState(localStorage.getItem("adminDevAuthSecret") || "");
  const [applied, setApplied] = useState(localStorage.getItem("telegramUserId") || "");
  if (!visible) return null;

  const apply = () => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return;
    localStorage.setItem("telegramUserId", trimmed);
    localStorage.setItem("adminDevAuthSecret", secret.trim());
    setApplied(trimmed);
    notifyIdentityChanged();
  };
  const clear = () => {
    localStorage.removeItem("telegramUserId");
    localStorage.removeItem("adminDevAuthSecret");
    setValue("");
    setSecret("");
    setApplied("");
    notifyIdentityChanged();
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-500 bg-amber-100 px-4 py-2.5 text-[13px]">
      <span className="rounded bg-amber-500 px-2 py-0.5 font-semibold text-white">DEV</span>
      <span>测试身份（仅本地开发环境可用）</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="Telegram 用户 ID"
        className="w-44 rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-2.5 py-1.5"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") apply();
        }}
      />
      <input
        type="password"
        placeholder="ADMIN_DEV_AUTH_SECRET"
        className="w-56 rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-2.5 py-1.5"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") apply();
        }}
      />
      <button className="btn" onClick={apply}>
        应用
      </button>
      {applied ? (
        <button className="btn" onClick={clear}>
          清除（当前 {applied}）
        </button>
      ) : null}
    </div>
  );
}

import { useState } from "react";
import { notifyIdentityChanged } from "../hooks";

// Staging-only identity simulation: /health reports environment=development on
// staging and local dev, and the x-telegram-user-id fallback is only accepted
// server-side in those environments.
export function TestBanner({ visible }: { visible: boolean }) {
  const [value, setValue] = useState(localStorage.getItem("telegramUserId") || "");
  const [applied, setApplied] = useState(localStorage.getItem("telegramUserId") || "");
  if (!visible) return null;

  const apply = () => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return;
    localStorage.setItem("telegramUserId", trimmed);
    setApplied(trimmed);
    notifyIdentityChanged();
  };
  const clear = () => {
    localStorage.removeItem("telegramUserId");
    setValue("");
    setApplied("");
    notifyIdentityChanged();
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-amber-500 bg-amber-100 px-4 py-2.5 text-[13px]">
      <span className="rounded bg-amber-500 px-2 py-0.5 font-semibold text-white">STAGING</span>
      <span>测试身份（仅 Staging / 本地环境可用）</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="Telegram 用户 ID"
        className="w-44 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5"
        value={value}
        onChange={(event) => setValue(event.target.value)}
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

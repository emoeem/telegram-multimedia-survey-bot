import { useState } from "react";

export function LoginPage() {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const value = input.trim();
    if (!value) {
      setError("请输入登录链接或登录凭证");
      return;
    }
    let token = value;
    if (value.startsWith("http")) {
      try {
        const parsed = new URL(value);
        token = parsed.searchParams.get("t") ?? "";
      } catch {
        setError("链接格式不正确");
        return;
      }
    }
    if (!token) {
      setError("链接中没有登录凭证");
      return;
    }
    window.location.href = `/api/admin/auth/browser?t=${encodeURIComponent(token)}`;
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">浏览器登录管理后台</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          在 Telegram 中向机器人发送 <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">/admin_login</code>，
          获取一次性登录链接（5 分钟有效）。把链接粘贴到下方，或直接点链接在浏览器打开。
        </p>
        <input
          className="input mt-4 w-full font-mono text-xs"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="粘贴登录链接…"
          autoFocus
        />
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button type="button" className="btn btn-primary mt-4 w-full" onClick={submit}>
          登录
        </button>
      </div>
    </div>
  );
}

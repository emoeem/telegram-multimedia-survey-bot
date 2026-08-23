import { useState } from "react";
import { ArrowRight, KeyRound, ListChecks, MessageCircle } from "lucide-react";

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
    <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <div className="card overflow-hidden p-0">
        <div className="bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-600 px-7 py-8 text-white">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/15 backdrop-blur">
            <ListChecks className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight">浏览器登录管理后台</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-indigo-100">
            在 Telegram 中向机器人发送 <code className="rounded bg-white/20 px-1.5 py-0.5 font-mono text-xs">/admin_login</code>，
            获取一次性登录链接（5 分钟有效），粘贴到下方即可。
          </p>
        </div>
        <div className="p-6">
          <label className="text-sm font-medium text-gray-700">登录链接 / 凭证</label>
          <div className="relative mt-2">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              className="input w-full pl-9 font-mono text-xs"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder="https://…/login?t=…"
              autoFocus
            />
          </div>
          {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
          <button type="button" className="btn btn-primary mt-4 w-full" onClick={submit}>
            登录
            <ArrowRight className="h-4 w-4" />
          </button>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-400">
            <MessageCircle className="h-3.5 w-3.5" />
            也可以直接点击 Telegram 中的链接在浏览器打开
          </p>
        </div>
      </div>
    </div>
  );
}

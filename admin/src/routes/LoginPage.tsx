import { Eye, EyeOff, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/auth/password", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      let body: { message?: string; redirect?: string } = {};
      try { body = (await response.json()) as typeof body; } catch { /* ignore malformed edge responses */ }
      if (!response.ok) throw new Error(body.message || `登录失败（HTTP ${response.status}）`);
      window.location.assign(body.redirect || "/admin/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <div className="card overflow-hidden p-0">
        <div className="bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-600 px-7 py-8 text-white">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--surface)]/15 backdrop-blur">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight">登录管理后台</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-indigo-100">输入管理员密码即可登录，无需 Telegram 验证或 OAuth。</p>
        </div>
        <form className="grid gap-4 p-6" onSubmit={login}>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium text-[var(--color-muted)]">管理员密码</span>
            <span className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-soft)]" />
              <input
                className="input w-full pr-10 pl-9"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入管理员密码"
                autoComplete="current-password"
                autoFocus
                required
              />
              <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--color-muted-soft)] hover:text-[var(--color-ink)]" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </span>
          </label>
          <button type="submit" className="btn btn-primary w-full" disabled={loading || !password}>
            {loading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}
            {loading ? "登录中…" : "登录管理后台"}
          </button>
          {message ? <p role="alert" className="text-sm text-[var(--color-danger)]">{message}</p> : null}
          <p className="text-center text-xs text-[var(--color-muted-soft)]">密码可在「系统设置」中修改。</p>
        </form>
      </div>
    </div>
  );
}

import { Eye, EyeOff, LoaderCircle, LockKeyhole, Send, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

/** How often the browser asks whether the bot has confirmed the login. */
const TELEGRAM_POLL_INTERVAL_MS = 2000;
/** Hard cap in case the backend reports a longer lifetime than the request. */
const TELEGRAM_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramHint, setTelegramHint] = useState("");
  const [telegramError, setTelegramError] = useState("");

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

  // Deep-link login: this page starts a request, the user confirms it inside the
  // Telegram bot, and we poll until the bot has approved (or cancelled) it.
  const telegramLogin = async () => {
    if (telegramLoading) return;
    setTelegramLoading(true);
    setTelegramError("");
    setTelegramHint("");
    // Opened synchronously: a window opened after the await counts as an
    // unsolicited popup and gets blocked. The deep link is known only later.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const startResponse = await fetch("/api/admin/auth/telegram/start", {
        credentials: "include",
        cache: "no-store",
      });
      let start: { loginUrl?: string; expiresIn?: number; message?: string } = {};
      try { start = (await startResponse.json()) as typeof start; } catch { /* ignore malformed edge responses */ }
      if (!startResponse.ok || !start.loginUrl) {
        throw new Error(start.message || `无法发起 Telegram 登录（HTTP ${startResponse.status}）`);
      }
      if (popup) popup.location.href = start.loginUrl;
      else window.open(start.loginUrl, "_blank");
      setTelegramHint("已打开 Telegram 机器人，请在那里点击「✅ 确认登录」完成验证，本页面会自动跳转。");
      const deadline = Date.now() + Math.min((start.expiresIn ?? 300) * 1000, TELEGRAM_LOGIN_TIMEOUT_MS);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_POLL_INTERVAL_MS));
        if (Date.now() >= deadline) {
          throw new Error("登录请求已超时，请重新点击「使用 Telegram 登录」。");
        }
        const statusResponse = await fetch("/api/admin/auth/telegram/status", {
          credentials: "include",
          cache: "no-store",
        });
        let status: { status?: string; message?: string } = {};
        try { status = (await statusResponse.json()) as typeof status; } catch { /* ignore malformed edge responses */ }
        if (!statusResponse.ok) throw new Error(status.message || `登录状态查询失败（HTTP ${statusResponse.status}）`);
        if (status.status === "approved") {
          window.location.assign("/admin");
          return;
        }
        if (status.status === "cancelled") {
          setTelegramHint("");
          setTelegramError("本次 Telegram 登录已在机器人中取消。");
          return;
        }
      }
    } catch (error) {
      setTelegramHint("");
      setTelegramError(error instanceof Error ? error.message : "Telegram 登录失败，请重试");
    } finally {
      setTelegramLoading(false);
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
        <div className="border-t border-[var(--color-edge-soft)] p-6">
          <div className="flex items-center gap-3 text-xs text-[var(--color-muted-soft)]">
            <span className="h-px flex-1 bg-[var(--color-edge-soft)]" />
            或者
            <span className="h-px flex-1 bg-[var(--color-edge-soft)]" />
          </div>
          <button
            type="button"
            className="btn btn-outline mt-4 w-full"
            onClick={telegramLogin}
            disabled={telegramLoading}
          >
            {telegramLoading ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {telegramLoading ? "等待 Telegram 确认…" : "使用 Telegram 登录"}
          </button>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted-soft)]">
            点击后会打开 Telegram 机器人；确认登录必须在 Telegram 机器人里点击「✅ 确认登录」，本页面不能自行完成验证。
          </p>
          {telegramHint ? <p className="mt-2 text-xs text-[var(--color-primary)]">{telegramHint}</p> : null}
          {telegramError ? <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{telegramError}</p> : null}
        </div>
      </div>
    </div>
  );
}

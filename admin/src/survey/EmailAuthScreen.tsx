import { useState } from "react";
import { MailCheck, LogIn, UserPlus } from "lucide-react";
import { loadGlobalPreset, themeBackgroundStyle, themeCssVars, useResolvedPreset } from "./theme-ui";

/**
 * Email + password auth screen (/auth) for visitors without Telegram:
 * register with an email verification code, log in, or reset the password.
 * The session token is stored in localStorage and attached to every
 * survey/trial request by identityHeaders().
 */

const SESSION_KEY = "emailSessionToken";
const EMAIL_KEY = "emailSessionEmail";

type Mode = "login" | "register" | "reset";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error((data.message as string) || "请求失败");
  return data as T;
}

export function EmailAuthScreen() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState(() => localStorage.getItem(EMAIL_KEY) ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rawGlobalPreset = loadGlobalPreset();
  const globalPreset = useResolvedPreset(rawGlobalPreset);
  const theme = globalPreset ? ({ preset: globalPreset } as Parameters<typeof themeCssVars>[0]) : null;
  const themeVars = themeCssVars(theme);
  const themeStyle = themeBackgroundStyle(theme);

  const needsCode = mode !== "login";

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/email/request-code", {
        email: email.trim(),
        purpose: mode === "reset" ? "reset" : "register",
      });
      setCodeSent(true);
      setNotice("验证码已发送，请查收邮箱（10 分钟内有效）。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const path =
        mode === "login"
          ? "/api/auth/email/login"
          : mode === "register"
            ? "/api/auth/email/register"
            : "/api/auth/email/reset";
      const data = await post<{ token: string; email: string }>(path, {
        email: email.trim(),
        password,
        ...(needsCode ? { code: code.trim() } : {}),
      });
      localStorage.setItem(SESSION_KEY, data.token);
      localStorage.setItem(EMAIL_KEY, data.email);
      window.location.href = "/s";
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "mt-1 w-full rounded-[var(--survey-button-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] px-3 py-2.5 text-sm text-[var(--survey-body)] outline-none focus:border-[var(--survey-primary)]";

  return (
    <div
      className="survey-glow flex min-h-dvh flex-col items-center px-5 pt-14"
      data-theme={globalPreset ?? undefined}
      style={{ ...themeVars, ...themeStyle }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-6 shadow-xl">
        <div className="flex items-center gap-2">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
            <MailCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--survey-heading)]">邮箱账号</h1>
            <p className="text-xs text-[var(--survey-muted)]">没有 Telegram 也能保存进度、上榜挑战</p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-1 rounded-xl bg-[var(--surface-muted)] p-1 text-xs font-semibold">
          {(
            [
              ["login", "登录"],
              ["register", "注册"],
              ["reset", "重置密码"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
                setNotice(null);
                setError(null);
                setCodeSent(false);
              }}
              className={`rounded-lg py-2 transition-colors ${
                mode === value
                  ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                  : "text-[var(--survey-muted)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs font-medium text-[var(--survey-muted)]">
          邮箱
          <input
            type="email"
            autoComplete="email"
            className={inputClass}
            value={email}
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        {needsCode ? (
          <div className="mt-3">
            <div className="flex items-end gap-2">
              <label className="block flex-1 text-xs font-medium text-[var(--survey-muted)]">
                验证码
                <input
                  inputMode="numeric"
                  maxLength={6}
                  className={inputClass}
                  value={code}
                  placeholder="6 位数字"
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                />
              </label>
              <button
                type="button"
                disabled={busy || !email.includes("@")}
                onClick={() => void requestCode()}
                className="shrink-0 rounded-[var(--survey-button-radius)] border border-[var(--survey-primary)] px-3 py-2.5 text-xs font-semibold text-[var(--survey-primary)] disabled:opacity-40"
              >
                {codeSent ? "重新发送" : "发送验证码"}
              </button>
            </div>
          </div>
        ) : null}

        <label className="mt-3 block text-xs font-medium text-[var(--survey-muted)]">
          密码（至少 8 位）
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <p className="mt-3 text-xs text-red-500">{error}</p> : null}
        {notice ? <p className="mt-3 text-xs text-emerald-600">{notice}</p> : null}

        <button
          type="button"
          disabled={busy || !email.includes("@") || password.length < 8 || (needsCode && code.length !== 6)}
          onClick={() => void submit()}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-3 text-sm font-bold text-[var(--survey-primary-content)] shadow-lg shadow-[color-mix(in_srgb,var(--survey-primary)_30%,transparent)] disabled:opacity-40"
        >
          {mode === "login" ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
          {busy ? "处理中…" : mode === "login" ? "登录" : mode === "register" ? "注册并登录" : "重置密码并登录"}
        </button>

        <a href="/s" className="mt-4 block text-center text-xs text-[var(--survey-muted)] underline">
          返回问卷主页
        </a>
      </div>
    </div>
  );
}

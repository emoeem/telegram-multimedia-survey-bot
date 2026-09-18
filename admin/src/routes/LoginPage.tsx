import { ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function LoginPage() {
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "waiting" | "error">("idle");
  const [message, setMessage] = useState("");
  const polling = useRef<number | null>(null);
  const finishing = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const requestVersion = useRef(0);
  const stopPolling = () => {
    if (polling.current !== null) window.clearInterval(polling.current);
    polling.current = null;
  };
  const startLogin = async () => {
    stopPolling();
    requestVersion.current += 1;
    finishing.current = false;
    setStatus("starting");
    setMessage("");
    try {
      const response = await fetch("/api/admin/auth/telegram/start", { method: "POST", credentials: "same-origin", cache: "no-store" });
      const body = await response.json();
      if (!response.ok || typeof body.loginUrl !== "string") throw new Error(body.message || "无法创建登录请求");
      setLoginUrl(body.loginUrl);
      setStatus("waiting");
      window.open(body.loginUrl, "_blank", "noopener,noreferrer");
      const version = requestVersion.current;
      const finish = (redirect: string) => {
        if (finishing.current || version !== requestVersion.current) return;
        finishing.current = true;
        stopPolling();
        setMessage("已确认，正在进入管理后台…");
        // The status response has already Set-Cookie'd the HttpOnly session.
        // Use a real browser navigation instead of React Router so the new
        // session is guaranteed to be picked up by the server-rendered entry.
        channelRef.current?.postMessage({ type: "LOGIN_APPROVED", redirect });
        window.location.assign(new URL(redirect, window.location.origin).href);
      };
      const poll = async () => {
        try {
          const result = await fetch("/api/admin/auth/telegram/status", {
            credentials: "include",
            cache: "no-store",
          });
          const state = (await result.json()) as { status?: string; message?: string; redirect?: string };
          if (state.status === "approved") {
            finish(state.redirect || "/admin/");
          } else if (state.status === "cancelled" || result.status === 410) {
            stopPolling();
            setStatus("error");
            setMessage(state.message || "登录请求已取消或过期，请重新开始登录。");
          } else if (!result.ok) {
            stopPolling();
            setStatus("error");
            setMessage(state.message || `登录状态检查失败（HTTP ${result.status}）`);
          }
        } catch {
          /* transient polling errors retry automatically */
        }
      };
      void poll();
      polling.current = window.setInterval(() => void poll(), 1500);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "无法开始登录");
    }
  };
  useEffect(() => {
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("admin-telegram-login") : null;
    channelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<{ type?: string; redirect?: string }>) => {
        if (event.data?.type !== "LOGIN_APPROVED" || finishing.current) return;
        finishing.current = true;
        stopPolling();
        window.location.assign(new URL(event.data.redirect || "/admin/", window.location.origin).href);
      };
    }
    return () => {
      stopPolling();
      channel?.close();
      channelRef.current = null;
    };
  }, []);
  return (
    <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <div className="card overflow-hidden p-0">
        <div className="bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-600 px-7 py-8 text-white">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[var(--surface)]/15 backdrop-blur">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-bold tracking-tight">登录管理后台</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-indigo-100">
            使用 Telegram 确认登录，不需要验证码、复制登录链接，也不需要配置 OAuth。
          </p>
        </div>
        <div className="p-6">
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={startLogin}
            disabled={status === "starting" || status === "waiting"}
          >
            {status === "starting" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            {status === "waiting" ? "等待 Telegram 确认…" : "使用 Telegram 登录"}
          </button>
          {loginUrl && status === "waiting" ? (
            <a className="btn btn-ghost mt-2 w-full" href={loginUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              如果没有自动打开，点击这里
            </a>
          ) : null}
          {status === "waiting" ? (
            <p className="mt-4 text-center text-xs text-[var(--color-muted-soft)]">
              请在 Telegram 中点击「确认登录」。确认后本页面会自动进入管理后台，无需刷新。
            </p>
          ) : null}
          {message ? <p className="mt-4 text-sm text-[var(--color-danger)]">{message}</p> : null}
        </div>
      </div>
    </div>
  );
}

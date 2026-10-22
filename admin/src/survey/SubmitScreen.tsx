/**
 * 网页投稿：投稿表单 + 投稿者收件箱。
 *
 * 视觉与问卷站其余页面共用同一套主题变量（--survey-*），所以并进前端工程后
 * 不需要额外样式依赖；数据全部来自投稿机器人 worker 的 /api/submit* 接口
 * （同域经 cn-relay 反代转发，浏览器看来就是本站接口）。
 *
 * 身份：网页投稿没有 Telegram 账号，用浏览器里的一串随机令牌当"我是谁"
 * （localStorage: webSubmitViewer，和旧的独立投稿页共用同一把 key，历史投稿不丢）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "./PageHeader";
import {
  SURVEY_CARD,
  SURVEY_CHIP,
  SURVEY_INPUT,
  SURVEY_PAGE,
  SURVEY_PRIMARY_BTN,
} from "./ui";

const VIEWER_KEY = "webSubmitViewer";
/* 卡片 / 按钮 / 输入框的类名统一来自 ui.ts，和 /plaza 引同一份，
 * 两页的圆角、边框、字号、触摸高度因此不会各写各的。 */
const CARD = SURVEY_CARD;
const BTN = SURVEY_PRIMARY_BTN;
const INPUT = SURVEY_INPUT;

interface SubmitStep {
  id: string;
  type: "text" | "choice" | "media";
  label: string;
  prompt: string;
  options: string[] | null;
  required: boolean;
  maxLength: number;
  showIf: { step: string; equals: string } | null;
}

interface SubmitFormDto {
  title: string;
  intro: string;
  captcha: boolean;
  maxFiles: number;
  maxFileMb: number;
  submitUrl: string;
  captchaUrl: string;
  inboxUrl: string;
  mainGroupUrl: string | null;
  steps: SubmitStep[];
}

interface InboxCommentDto {
  messageId: number;
  name: string;
  text: string;
  parentAuthor: string | null;
  createdAt: number;
  isMine: boolean;
}

interface InboxItemDto {
  id: number;
  status: string;
  title: string;
  createdAt: number;
  mediaCount: number;
  comments: InboxCommentDto[];
  unreadComments: number;
  thread: Array<{ direction: string; text: string; createdAt: number }>;
  unreadThread: number;
}

function viewerToken(): string {
  if (typeof window === "undefined") return "";
  let stored = "";
  try {
    stored = window.localStorage.getItem(VIEWER_KEY) ?? "";
  } catch {
    stored = "";
  }
  if (/^[a-f0-9]{16,64}$/i.test(stored)) return stored;
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    window.localStorage.setItem(VIEWER_KEY, token);
  } catch {
    /* 无痕模式下存不住，本次会话仍然可用 */
  }
  return token;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "审核中",
  publishing: "发布中",
  published: "已发布",
  rejected: "未通过",
  recalled: "已撤下",
  failed: "发布失败",
  deleted: "已删除",
};

function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function SubmitScreen() {
  const viewer = useMemo(() => viewerToken(), []);
  const [form, setForm] = useState<SubmitFormDto | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaQuestion, setCaptchaQuestion] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [error, setError] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: number; status: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadCaptcha = useCallback(async () => {
    if (!form?.captcha) return;
    try {
      const response = await fetch(form.captchaUrl);
      const data = (await response.json()) as { token?: string; question?: string };
      setCaptchaToken(data.token ?? "");
      setCaptchaQuestion(data.question ?? "");
    } catch {
      setError(["验证题加载失败，请刷新页面重试"]);
    }
  }, [form]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/submit/form");
        const data = (await response.json()) as { ok: boolean; form?: SubmitFormDto; error?: string };
        if (cancelled) return;
        if (!data.ok || !data.form) throw new Error(data.error ?? "表单加载失败");
        setForm(data.form);
      } catch (caught) {
        if (!cancelled) setError([caught instanceof Error ? caught.message : String(caught)]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (form) void loadCaptcha();
  }, [form, loadCaptcha]);

  const visibleSteps = useMemo(() => {
    if (!form) return [];
    return form.steps.filter((step) => {
      if (step.type === "media") return true;
      if (!step.showIf) return true;
      return String(values[step.showIf.step] ?? "") === String(step.showIf.equals);
    });
  }, [form, values]);

  const mediaStep = useMemo(() => form?.steps.find((step) => step.type === "media") ?? null, [form]);

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (!form || !incoming.length) return;
      const limit = form.maxFiles;
      const maxBytes = form.maxFileMb * 1024 * 1024;
      const merged = [...files, ...incoming].slice(0, limit);
      const tooBig = merged.find((file) => file.size > maxBytes);
      if (tooBig) {
        setError([`「${tooBig.name}」超过 ${form.maxFileMb} MB，请压缩后再传`]);
        return;
      }
      setError([]);
      setFiles(merged);
    },
    [files, form],
  );

  const submit = useCallback(async () => {
    if (!form) return;
    const problems: string[] = [];
    for (const step of visibleSteps) {
      if (step.type === "media") continue;
      const value = String(values[step.id] ?? "").trim();
      if (!value && step.required) problems.push(`${step.label}：请填写`);
      if (step.type === "choice" && value && step.options && !step.options.includes(value)) {
        problems.push(`${step.label}：选项不正确`);
      }
      if (value.length > step.maxLength) problems.push(`${step.label}：最多 ${step.maxLength} 字`);
    }
    if (values.author === "显示我的昵称" && !nickname.trim()) problems.push("昵称：选了「显示我的昵称」，请填昵称或改成匿名");
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) problems.push("邮箱格式看起来不对（不填也没关系）");
    if (problems.length) {
      setError(problems);
      return;
    }

    const body = new FormData();
    for (const step of form.steps) {
      if (step.type === "media") continue;
      const value = String(values[step.id] ?? "").trim();
      if (value) body.append(`step:${step.id}`, value);
    }
    if (mediaStep) for (const file of files) body.append(`file:${mediaStep.id}`, file, file.name);
    if (nickname.trim()) body.append("nickname", nickname.trim());
    if (email.trim()) body.append("email", email.trim());
    body.append("viewer", viewer);
    body.append("token", captchaToken);
    if (form.captcha) body.append("captcha", captchaAnswer.trim());

    setBusy(true);
    setError([]);
    try {
      const response = await fetch(form.submitUrl, { method: "POST", body });
      const data = (await response.json()) as {
        ok: boolean;
        id?: number;
        status?: string;
        error?: string;
        errors?: Record<string, string>;
      };
      if (!data.ok) {
        const lines = data.errors ? Object.values(data.errors) : [];
        if (data.error) lines.unshift(data.error);
        setError(lines.length ? lines : ["提交失败，请稍后再试"]);
        if (response.status === 429 || response.status === 403) void loadCaptcha();
        return;
      }
      setDone({ id: data.id ?? 0, status: data.status ?? "pending" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError(["网络不太顺畅，请稍后再试"]);
    } finally {
      setBusy(false);
    }
  }, [captchaAnswer, captchaToken, email, files, form, loadCaptcha, mediaStep, nickname, values, viewer, visibleSteps]);

  const nav = "flex items-center justify-center gap-2 text-[13px] text-[var(--survey-muted)]";

  if (done) {
    return (
      <main className="mx-auto max-w-xl px-4 pb-24 pt-6">
        <div className={`${CARD} p-6 text-center`}>
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-lg font-semibold text-[var(--survey-heading)]">投稿已收到</h1>
          <p className="mt-1 text-[13px] text-[var(--survey-muted)]">
            编号 #{done.id} ·{" "}
            {done.status === "published" ? "已发布，多谢投稿！" : "管理员审核通过后会发布"}
          </p>
          <a className={`${BTN} mt-4`} href="/submit/inbox">
            📬 打开我的投稿收件箱
          </a>
          <p className="mt-3 text-[12px] text-[var(--survey-muted)]">
            收件箱能看到审核进度、别人的评论（可直接回复）和管理员留言；留了邮箱的话新评论会发邮件通知你。
          </p>
        </div>
        <p className={`${nav} mt-4`}>
          <a href="/s">← 回问卷首页</a>
        </p>
      </main>
    );
  }

  return (
    <div className="survey-glow min-h-dvh">
      <PageHeader
        title={form?.title ?? "📮 投稿"}
        subtitle="不用注册 · 审核通过后发布"
        actions={
          <>
            {/* /submit 是独立表单页（没有底部全局导航），所以认证卡入口放在
                顶栏，和收件箱同一套 .survey-header-pill；窄屏 ≤360px 只剩
                图标，不会把标题挤掉。 */}
            <a className="survey-header-pill" href="/cert/" aria-label="认证卡生成器" title="认证卡生成器">
              🪪<span className="pill-text"> 认证卡</span>
            </a>
            <a className="survey-header-pill" href="/submit/inbox" aria-label="我的投稿收件箱">
              📬<span className="pill-text"> 收件箱</span>
            </a>
          </>
        }
      />
      <main className={`${SURVEY_PAGE} pb-32 pt-3`}>
        <p className="mb-3 whitespace-pre-wrap text-[13px] leading-6 text-[var(--survey-muted)]">
          {form?.intro ?? "正在加载投稿表单…"}
        </p>

      {error.length > 0 ? (
        <div className="mb-3 rounded-[var(--survey-radius)] border border-red-400/60 px-3 py-2 text-[13px] text-red-500">
          {error.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      {!form ? null : (
        <>
          <section className={`${CARD} mb-3 p-4`}>
            {visibleSteps
              .filter((step) => step.type !== "media")
              .map((step) => (
                <div className="mb-4 last:mb-0" key={step.id}>
                  <label className="flex items-center justify-between text-[14px] font-semibold text-[var(--survey-heading)]">
                    <span>
                      {step.label}
                      {step.required ? <span className="ml-0.5 text-red-500">*</span> : null}
                    </span>
                    {step.type === "text" ? (
                      <span className="text-[12px] font-normal text-[var(--survey-muted)]">
                        {(values[step.id] ?? "").length}/{step.maxLength} 字
                      </span>
                    ) : null}
                  </label>
                  {step.type === "choice" ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(step.options ?? []).map((option) => {
                        const active = values[step.id] === option;
                        return (
                          <button
                            className={`${SURVEY_CHIP} ${
                              active
                                ? "border-[var(--survey-primary)] bg-[var(--survey-primary)]/10 font-semibold text-[var(--survey-primary)]"
                                : "border-[var(--survey-card-border)] text-[var(--survey-heading)]"
                            }`}
                            key={option}
                            onClick={() => setValues((prev) => ({ ...prev, [step.id]: option }))}
                            type="button"
                          >
                            {option}
                          </button>
                        );
                      })}
                    </div>
                  ) : step.maxLength > 120 ? (
                    <textarea
                      className={`${INPUT} mt-2 min-h-[130px]`}
                      maxLength={step.maxLength}
                      onChange={(event) => setValues((prev) => ({ ...prev, [step.id]: event.target.value }))}
                      value={values[step.id] ?? ""}
                    />
                  ) : (
                    <input
                      className={`${INPUT} mt-2`}
                      maxLength={step.maxLength}
                      onChange={(event) => setValues((prev) => ({ ...prev, [step.id]: event.target.value }))}
                      value={values[step.id] ?? ""}
                    />
                  )}
                  <p className="mt-2 text-[12px] leading-5 text-[var(--survey-muted)]">{step.prompt}</p>
                </div>
              ))}
          </section>

          {mediaStep ? (
            <section className={`${CARD} mb-3 p-4`}>
              <p className="text-[14px] font-semibold text-[var(--survey-heading)]">{mediaStep.label}</p>
              <div
                className={`mt-2 rounded-[var(--survey-radius)] border-2 border-dashed px-4 py-5 text-center text-[13px] text-[var(--survey-muted)] ${
                  dragging ? "border-[var(--survey-primary)] text-[var(--survey-primary)]" : "border-[var(--survey-card-border)]"
                }`}
                role="button"
                tabIndex={0}
                aria-label="添加图片或视频"
                onClick={() => fileInput.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInput.current?.click();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDragging(false);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  addFiles(Array.from(event.dataTransfer.files));
                }}
              >
                {/* 移动端没有拖拽：整块都是点击入口，拖拽文案只作提示 */}
                <p className="hidden sm:block">把图片/视频拖到这里，或</p>
                <p className="sm:hidden">点这里选择图片 / 视频</p>
                <span className="mt-2 inline-flex min-h-11 items-center rounded-full border border-[var(--survey-primary)] px-5 text-[13px] font-semibold text-[var(--survey-primary)]">
                  选择文件
                </span>
                <input
                  accept="image/*,video/*"
                  className="hidden"
                  multiple
                  onChange={(event) => addFiles(Array.from(event.target.files ?? []))}
                  ref={fileInput}
                  type="file"
                />
                <p className="mt-2">
                  最多 {form.maxFiles} 个，每个不超过 {form.maxFileMb} MB
                </p>
              </div>
              {files.length > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {files.map((file, index) => (
                    <div className="relative aspect-square overflow-hidden rounded-[10px] border border-[var(--survey-card-border)]" key={`${file.name}-${index}`}>
                      {file.type.startsWith("image/") ? (
                        <img alt={file.name} className="h-full w-full object-cover" src={URL.createObjectURL(file)} />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-[11px] text-[var(--survey-muted)]">🎬</span>
                      )}
                      <button
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[13px] text-white"
                        onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className={`${CARD} mb-3 p-4`}>
            <label className="text-[14px] font-semibold text-[var(--survey-heading)]">昵称（选填）</label>
            <input className={`${INPUT} mt-2`} maxLength={32} onChange={(event) => setNickname(event.target.value)} value={nickname} />
            <p className="mt-2 text-[12px] text-[var(--survey-muted)]">署名方式选了「显示我的昵称」时必填；选匿名就不用管它。</p>
            <label className="mt-4 block text-[14px] font-semibold text-[var(--survey-heading)]">邮箱（选填）</label>
            <input
              className={`${INPUT} mt-2`}
              inputMode="email"
              maxLength={120}
              onChange={(event) => setEmail(event.target.value)}
              value={email}
            />
            <p className="mt-2 text-[12px] text-[var(--survey-muted)]">
              留了邮箱，审核结果和新评论会发邮件通知你；不填也能用，收件箱里一样能看到。
            </p>
            {form.captcha ? (
              <>
                <label className="mt-4 block text-[14px] font-semibold text-[var(--survey-heading)]">
                  验证<span className="ml-0.5 text-red-500">*</span>
                </label>
                <p className="mt-2 text-[13px] text-[var(--survey-muted)]">请算一下：{captchaQuestion || "…"}</p>
                <input
                  className={`${INPUT} mt-2`}
                  inputMode="numeric"
                  onChange={(event) => setCaptchaAnswer(event.target.value)}
                  value={captchaAnswer}
                />
              </>
            ) : null}
          </section>

          {/* 固定在视口底部：不用负外边距（那会在窄屏撑出 2px 横向滚动），
              下方留白由 main 的 pb-32 让出来，最后一个字段不会被挡住。 */}
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--survey-card-border)] bg-[color-mix(in_srgb,var(--survey-card-bg)_92%,transparent)] px-4 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] pt-3 backdrop-blur-md">
            <div className="mx-auto max-w-xl">
              <button className={BTN} disabled={busy} onClick={() => void submit()} type="button">
                {busy ? "正在上传…" : "提交投稿"}
              </button>
              <p className="mt-1.5 text-center text-[11px] leading-4 text-[var(--survey-muted)]">
                提交即表示同意内容被公开发布；审核不通过不会发布。
              </p>
            </div>
          </div>
        </>
      )}
      </main>
    </div>
  );
}

export function SubmitInboxScreen() {
  const viewer = useMemo(() => viewerToken(), []);
  const [items, setItems] = useState<InboxItemDto[] | null>(null);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    if (!viewer) {
      setItems([]);
      return;
    }
    try {
      const response = await fetch(`/api/submit/inbox?t=${encodeURIComponent(viewer)}`);
      const data = (await response.json()) as { ok: boolean; items?: InboxItemDto[]; error?: string };
      if (!data.ok) throw new Error(data.error ?? "打不开收件箱");
      setItems(data.items ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, payload: Record<string, unknown>) => {
      setError("");
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ viewer, ...payload }),
        });
        const data = (await response.json()) as { ok: boolean; error?: string };
        if (!data.ok) throw new Error(data.error ?? "操作失败");
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [load, viewer],
  );

  return (
    <div className="survey-glow min-h-dvh">
      <PageHeader
        title="📬 我的投稿"
        subtitle="进度 · 评论 · 管理员留言"
        actions={
          <a className="survey-header-pill" href="/submit">
            ✍️<span className="pill-text"> 再投一稿</span>
          </a>
        }
      />
      <main className={`${SURVEY_PAGE} pb-8 pt-3`}>
        <p className="mb-1 text-[13px] leading-6 text-[var(--survey-muted)]">
          这里能看到你投过的稿、审核进度、别人的评论（可直接回复）和管理员留言。
        </p>
      {error ? (
        <div className="mt-3 rounded-[var(--survey-radius)] border border-red-400/60 px-3 py-2 text-[13px] text-red-500">{error}</div>
      ) : null}

      {items === null ? (
        <p className="mt-6 text-center text-[13px] text-[var(--survey-muted)]">正在加载…</p>
      ) : items.length === 0 ? (
        <div className={`${CARD} mt-4 p-5 text-center`}>
          <p className="text-[13px] text-[var(--survey-muted)]">这个浏览器还没有投稿记录。</p>
          <a className={`${BTN} mt-3`} href="/submit">
            去投稿
          </a>
        </div>
      ) : (
        items.map((item) => {
          const unread = item.unreadComments + item.unreadThread;
          return (
            <section className={`${CARD} mt-3 p-4`} key={item.id}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[15px] font-semibold text-[var(--survey-heading)]">
                  #{item.id} {item.title}
                </h2>
                {unread > 0 ? (
                  <span className="shrink-0 rounded-full bg-[var(--survey-primary)] px-2 py-0.5 text-[11px] font-semibold text-[var(--survey-primary-content)]">
                    {unread} 条新消息
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-[var(--survey-muted)]">
                <span className="rounded-full border border-[var(--survey-card-border)] px-2 py-0.5">
                  {STATUS_LABEL[item.status] ?? item.status}
                </span>
                <span>{formatTime(item.createdAt)}</span>
                {item.mediaCount > 0 ? <span>{item.mediaCount} 个附件</span> : null}
              </div>

              {item.comments.length === 0 ? (
                <p className="mt-3 text-[12px] text-[var(--survey-muted)]">还没有评论。</p>
              ) : (
                item.comments.map((comment) => (
                  <div
                    className={`mt-3 border-t border-[var(--survey-card-border)] pt-2 text-[13px] ${
                      comment.isMine ? "rounded-[var(--survey-radius)] bg-[var(--survey-primary)]/5 p-2" : ""
                    }`}
                    key={comment.messageId}
                  >
                    <p className="text-[12px] font-semibold text-[var(--survey-heading)]">
                      {comment.name}
                      {comment.parentAuthor ? ` ↩️ 回复 ${comment.parentAuthor}` : ""}
                      <span className="ml-2 font-normal text-[var(--survey-muted)]">{formatTime(comment.createdAt)}</span>
                    </p>
                    <p className="mt-1 text-[var(--survey-heading)]">{comment.text}</p>
                    {!comment.isMine ? (
                      <button
                        className="mt-1 text-[12px] font-medium text-[var(--survey-primary)]"
                        onClick={() => {
                          const text = window.prompt("回复这条评论（会以「作者回复」公开出现在评论区）：");
                          if (text && text.trim()) {
                            void post("/api/submit/reply", {
                              submissionId: item.id,
                              commentMessageId: comment.messageId,
                              text: text.trim(),
                            });
                          }
                        }}
                        type="button"
                      >
                        ↩️ 回复这条评论
                      </button>
                    ) : null}
                  </div>
                ))
              )}

              <div className="mt-3 rounded-[var(--survey-radius)] bg-[var(--survey-primary)]/5 p-3">
                {item.thread.length === 0 ? (
                  <p className="text-[12px] text-[var(--survey-muted)]">想跟管理员说点什么？（只有管理员能看到，不会公开）</p>
                ) : (
                  item.thread.map((message, index) => (
                    <p
                      className={`mt-1 text-[13px] ${message.direction === "to_admin" ? "text-right text-[var(--survey-primary)]" : "text-[var(--survey-heading)]"}`}
                      key={`${message.createdAt}-${index}`}
                    >
                      {message.direction === "to_admin" ? "我：" : "管理员："}
                      {message.text}
                      <span className="ml-2 text-[11px] text-[var(--survey-muted)]">{formatTime(message.createdAt)}</span>
                    </p>
                  ))
                )}
                <div className="mt-2 flex items-end gap-2">
                  <textarea
                    className={`${INPUT} min-h-[44px] flex-1`}
                    maxLength={800}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    placeholder="给管理员留言…"
                    value={drafts[item.id] ?? ""}
                  />
                  <button
                    className={`${BTN} px-3 py-2`}
                    onClick={() => {
                      const text = (drafts[item.id] ?? "").trim();
                      if (!text) return;
                      void post("/api/submit/message", { submissionId: item.id, text }).then(() =>
                        setDrafts((prev) => ({ ...prev, [item.id]: "" })),
                      );
                    }}
                    type="button"
                  >
                    发送
                  </button>
                </div>
              </div>
            </section>
          );
        })
      )}

      </main>
    </div>
  );
}

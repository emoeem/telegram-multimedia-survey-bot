/**
 * 免登录投稿表单的预取 —— 模块级缓存的一份 in-flight promise。
 *
 * 为什么值得单独一个模块：`/submissions` 的加载链原本是纯串行 ——
 * survey.js 执行 → SubmissionHub chunk → SubmitScreen chunk →
 * fetch(/api/submit/form)（经代理跨 Worker，冷启 0.7s+）→ 验证题再一跳。
 * 用户在慢网络里点开投稿中心，要等整条链走完才看到第一个字段。
 *
 * 把 fetch 从 SubmitScreen 挂载时提前到 SubmissionHub 挂载时（无论当前在
 * 哪个页签、哪种模式），SubmitScreen 真正挂载时复用同一份 promise，链上
 * 砍掉一到两个来回。这里只做**本次页面加载内**的内存缓存：接口带
 * `Cache-Control: no-store`（审核配置实时可变），跨会话缓存会把运营改过的
 * 字段定格在旧版本。
 *
 * 失败要能重试：缓存的 promise 一旦 reject 就自清，重试等于重新发起。
 */

export interface SubmitStep {
  id: string;
  type: "text" | "choice" | "media";
  label: string;
  prompt: string;
  options: string[] | null;
  required: boolean;
  maxLength: number;
  showIf: { step: string; equals: string } | null;
}

export interface SubmitFormDto {
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

let cached: Promise<SubmitFormDto> | null = null;

async function fetchForm(): Promise<SubmitFormDto> {
  const response = await fetch("/api/submit/form");
  const data = (await response.json()) as { ok: boolean; form?: SubmitFormDto; error?: string };
  if (!data.ok || !data.form) throw new Error(data.error ?? "表单加载失败");
  return data.form;
}

/** 拉表单；同一页面加载内复用同一份请求。 */
export function preloadSubmitForm(): Promise<SubmitFormDto> {
  if (!cached) {
    cached = fetchForm().catch((error: unknown) => {
      /* 失败的 promise 缓存住毫无意义 —— 调用方重试时必须能真的重发。 */
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** 丢弃缓存，下一次 preloadSubmitForm 重新发起请求（供「重试」按钮用）。 */
export function resetSubmitFormPreload(): void {
  cached = null;
}

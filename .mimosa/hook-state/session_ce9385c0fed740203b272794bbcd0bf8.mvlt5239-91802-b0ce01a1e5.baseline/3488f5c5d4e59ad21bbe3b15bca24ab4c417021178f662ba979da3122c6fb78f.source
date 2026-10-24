/**
 * 投稿入口解析 —— 纯函数，不碰 DOM、不发请求。
 *
 * 单独一个模块有两个原因：一是文案逻辑本身可测（worker 的 Node 测试环境没有 DOM，
 * import `plaza-api.ts` 会连带把 fetch/window 依赖拉进来）；二是这条文案被三个页面
 * 共用，重复实现正是「投稿机器人 投稿机器人」那次事故的成因。
 */

export type SubmissionTarget = { kind: "bot" | "web"; label: string };

/**
 * 把配置里的投稿入口解析成可直接嵌入文案的目标。
 *
 * `SUBMISSION_BOT_URL` 既可能是 t.me 机器人，也可能是一个网页投稿页（本部署就是
 * `https://emoemok.top/submit`）。旧实现解析不出 handle 时返回 "投稿机器人"，而调用方
 * 已经把「投稿机器人」写进了文案，页面上于是出现「投稿机器人 投稿机器人，投稿给我」。
 *
 * 现在返回的是「目标」而不是「名字」：t.me → `@handle`，其他 → 域名；空值 → null，
 * 调用方据此整块不渲染。label 永不为空，避免出现「通过  投稿你的内容」这种空档句。
 */
export function submissionTargetFromUrl(url: string | null | undefined): SubmissionTarget | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  const handle = trimmed.match(/t\.me\/([A-Za-z0-9_]{2,})/i);
  if (handle) return { kind: "bot", label: `@${handle[1]}` };
  try {
    const host = new URL(trimmed).hostname.replace(/^www\./i, "");
    return { kind: "web", label: host };
  } catch {
    // 不是合法 URL（例如配置成了裸域名）：退回去掉协议和路径的第一段。
    const bare = trimmed.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? trimmed;
    return { kind: "web", label: bare || trimmed };
  }
}

import type { Env } from "../index";
import { ADMIN_SESSION_COOKIE, resolveSessionSecret, verifyAdminSessionValue } from "../services/admin-session.service";
import { loadAdminSessionEpoch } from "../services/system-settings.service";

/**
 * 请求是否携带有效的管理员会话 cookie（浏览器同源请求会自动带上）。
 *
 * 公开路由上的两个合法用途：
 *  1. 媒体端点——草稿/未挂载素材的管理员预览（`/api/survey/media/:id`）；
 *  2. 问卷定义——编辑器的「设备预览」iframe 加载真实 `/s/:id`（草稿也要能看）。
 *
 * 只做身份校验，不返回用户：调用方拿到的就是一个布尔，避免顺手把会话
 * 数据带进公开响应。其余零成本路径（已发布问卷的普通访问）不会走到这里。
 */
export async function hasValidAdminSession(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!cookie) return false;
  const epoch = await loadAdminSessionEpoch(env.DB);
  const userId = await verifyAdminSessionValue(
    resolveSessionSecret(env),
    cookie.slice(ADMIN_SESSION_COOKIE.length + 1),
    epoch,
  );
  return userId !== null;
}

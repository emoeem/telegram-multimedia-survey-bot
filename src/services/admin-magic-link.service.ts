/**
 * 一次性免密登录链接（magic link）。
 *
 * 场景：体验创作者大多不是技术用户，「开网页 → 点按钮 → 跳 Telegram → 点确认 →
 * 切回浏览器 → 5 分钟内完成」这条链路太长，很容易失败。所以机器人里的
 * 「🌐 网页管理后台」按钮直接给一个一次性链接，点开即登录：
 *
 * - KV 只存短状态（30 分钟 TTL）；永久的一次性由 D1 的唯一行保证 —— KV 没有
 *   compare-and-swap，并发兑换必须靠 `admin_login_consumptions` 的主键裁决
 *   （和浏览器发起、机器人确认的登录流程共用同一张表）。
 * - 兑换时会**重新**校验后台权限（管理员或有效体验创作者），所以链接过期撤销授权
 *   后立刻失效，不会因为链接还活着就继续放行。
 */
const encoder = new TextEncoder();
const MAGIC_LINK_PREFIX = "admin-magic-link:";

/** 链接有效期：够在聊天里点开，又不至于长期躺在历史消息里还能用。 */
export const ADMIN_MAGIC_LINK_TTL_SECONDS = 30 * 60;

interface MagicLinkState {
  userId: number;
  createdAt: number;
}

function randomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 链接里的 token 形状（随机 32 字符 base64url）；非法形状直接拒绝，不查 KV。 */
export function isAdminMagicLinkToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export async function createAdminMagicLink(cache: KVNamespace, userId: number): Promise<string> {
  const id = randomId();
  await cache.put(
    MAGIC_LINK_PREFIX + id,
    JSON.stringify({ userId, createdAt: Date.now() } satisfies MagicLinkState),
    { expirationTtl: ADMIN_MAGIC_LINK_TTL_SECONDS },
  );
  return id;
}

/**
 * 兑换链接：返回用户 id，失败返回 null。**只能成功一次**。
 */
export async function consumeAdminMagicLink(
  db: D1Database,
  cache: KVNamespace,
  token: string,
): Promise<number | null> {
  if (!isAdminMagicLinkToken(token)) return null;
  const raw = await cache.get(MAGIC_LINK_PREFIX + token);
  if (!raw) return null;
  let state: MagicLinkState;
  try {
    state = JSON.parse(raw) as MagicLinkState;
  } catch {
    return null;
  }
  if (!Number.isInteger(state.userId) || state.userId <= 0) return null;

  // 唯一行 = 原子的一次性闸门：并发的两个请求里只有一个能写入成功。
  const claimed = await db
    .prepare(
      `INSERT INTO admin_login_consumptions (login_request_id, telegram_user_id, consumed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(login_request_id) DO NOTHING`,
    )
    .bind(`magic:${token}`, state.userId, new Date().toISOString())
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) return null;

  await cache.delete(MAGIC_LINK_PREFIX + token).catch(() => undefined);
  return state.userId;
}

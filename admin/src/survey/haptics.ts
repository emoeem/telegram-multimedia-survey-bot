/** Lightweight wrapper around the Haptic Feedback API (navigator.vibrate)
 *  and the Web Notification API, both of which are gracefully no-ops on
 *  platforms that don't support them (desktop Safari, older iOS WebViews, etc).
 *
 *  These helpers are used by the trial/challenge screen to give players
 *  tactile and ambient feedback for key events (complete, fail, settlement),
 *  以及问卷提交成功/失败（见 SurveyApp 的 submit）——提交失败没有震动时，
 *  用户很容易以为"点了没反应"。
 *
 *  两条通路，不是两份实现：
 *   1. Telegram 的 `WebApp.HapticFeedback.notificationOccurred(type)` —— Mini App
 *      内的官方通路（iOS 上 `navigator.vibrate` 根本不存在，这是唯一会真的震动的
 *      一条）；
 *   2. `navigator.vibrate` —— 普通浏览器 / Android WebView 的兜底。
 *  两者都调用、互不排斥：Telegram 客户端里 vibrate 通常无效但无害，浏览器里
 *  HapticFeedback 不存在直接跳过。**绝不因为第一次没震动就在各处再实现一份。** */

interface TelegramHaptics {
  notificationOccurred?: (type: "error" | "success" | "warning") => void;
  impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
}

function telegramHaptics(): TelegramHaptics | undefined {
  // 用 globalThis 而不是 `window`：本文件同时被 admin 工程（lib DOM）和根工程
  // （lib WebWorker，没有 window 这个标识符）编译，globalThis 两边都在。
  const scope = globalThis as unknown as {
    Telegram?: { WebApp?: { HapticFeedback?: TelegramHaptics } };
  };
  return scope.Telegram?.WebApp?.HapticFeedback;
}

function notifyTelegram(type: "error" | "success" | "warning"): void {
  try {
    telegramHaptics()?.notificationOccurred?.(type);
  } catch {
    /* 老客户端不支持 / 版本签名不同：震动是锦上添花，绝不能因此抛错 */
  }
}

/**
 * `navigator.vibrate` 只存在于浏览器 DOM 类型里；本文件同时被 admin 工程和根
 * 工程（@cloudflare/workers-types，那里 navigator 是 WorkerNavigator）编译，
 * 所以按能力探测读取，而不是依赖某个库的类型声明。
 */
function buzz(pattern: number | number[]): void {
  const nav = (typeof navigator === "undefined" ? undefined : navigator) as
    { vibrate?: (pattern: number | number[]) => boolean } | undefined;
  if (typeof nav?.vibrate !== "function") return;
  try {
    nav.vibrate(pattern);
  } catch {
    /* 部分 WebView 会以 NotAllowed 抛错（无用户手势）；静默忽略 */
  }
}

export function vibrateSuccess(): void {
  notifyTelegram("success");
  buzz(25);
}

export function vibrateFail(): void {
  notifyTelegram("error");
  buzz([60, 40, 80]);
}

export function vibrateLight(): void {
  try {
    telegramHaptics()?.impactOccurred?.("light");
  } catch {
    /* 同上 */
  }
  buzz(15);
}

/** 同上：`requestPermission` 在 workers 类型里不存在，按能力探测而不是按类型假设。 */
type NotificationPermissionApi = {
  permission?: NotificationPermission | string;
  requestPermission?: () => Promise<NotificationPermission>;
};

function notificationApi(): NotificationPermissionApi | undefined {
  return (typeof Notification === "undefined" ? undefined : Notification) as NotificationPermissionApi | undefined;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  const api = notificationApi();
  if (typeof api?.requestPermission !== "function") return "unsupported";
  if (api.permission === "granted" || api.permission === "denied") return api.permission;
  try {
    return await api.requestPermission();
  } catch {
    return "unsupported";
  }
}

export function notify(title: string, body?: string): void {
  if (notificationApi()?.permission !== "granted") return;
  try {
    // 展开而不是 `body: undefined`：根 tsconfig 开了 exactOptionalPropertyTypes
    // （admin 的测试也从根工程里跑，所以这里必须同时满足两套配置）。
    new Notification(title, { ...(body === undefined ? {} : { body }), silent: true });
  } catch {
    /* best effort — ignore */
  }
}

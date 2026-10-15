/**
 * 问卷媒体的适度预加载。
 *
 * 「下一题」的资源在答题者阅读当前题的空档里预热，翻题时图片已经在本机缓存里，
 * 不用再等一个跨网请求。约束：
 * - 只预加载**公开的**问卷定义媒体（题面/选项图，服务端 survey 范围不需要任何
 *   身份头，`<img src>` 与预加载用的 `new Image()` 都能命中浏览器 HTTP 缓存）；
 *   答卷上传预览是私有资源，绝不在这里预热。
 * - 弱网与省流量模式（saveData / 2G / 3G）跳过：预加载和首屏、保存请求抢同一条
 *   链路，功能不受影响，只是换题时再加载。
 * - 限流：一次最多 N 张，超出部分不排（下一题的媒体通常是 1-3 张，N 只作
 *   兜底），避免巨型选项图集把带宽吃光。
 * - 预加载失败静默：真渲染时 `<img>` 自己会再走一遍缓存/网络与错误展示。
 */

/** 与 SpriteLayer 共用的「该不该预下载」判定。 */
export function shouldSkipPreload(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
    .connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return Boolean(connection.effectiveType && connection.effectiveType !== "4g");
}

/** 单次预加载的图片数量上限：正常一题 1-3 张，这只兜住病态数据。 */
const MAX_PRELOAD_IMAGES = 8;

/**
 * 用浏览器图片缓存预热一批 URL。返回是否真的发起了预加载
 * （false = 弱网跳过或没有可预加载的图）。
 */
export function preloadImages(urls: string[]): boolean {
  if (urls.length === 0 || shouldSkipPreload()) return false;
  for (const url of urls.slice(0, MAX_PRELOAD_IMAGES)) {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
  }
  return true;
}

/** 从一道题的 DTO 里收集可预加载的图片 URL（题面 + 选项配图，仅 image 类）。 */
export function collectQuestionImageUrls(question: {
  media: Array<{ url: string }>;
  options: Array<{ media: Array<{ url: string }> }>;
}): string[] {
  const urls: string[] = [];
  for (const media of question.media) urls.push(media.url);
  for (const option of question.options) {
    for (const media of option.media) urls.push(media.url);
  }
  return urls;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page, type Request, type Route } from "@playwright/test";

/**
 * End-to-end playthrough of the real production visual novel `/s/118`.
 *
 * The definition under `qa/fixtures/galgame-118.json` is a byte-for-byte copy
 * of what `https://emoemok.top/api/survey/118` serves, and every illustration and
 * BGM track is fetched live from production and re-served same-origin, so this
 * suite renders the real story, the real artwork and the real audio while
 * writing nothing to production.
 *
 * It covers the phase-5/6/7 requirements that a database inspection cannot:
 * every illustration actually decodes in the browser, the per-page BGM really
 * follows `theme.audio.byPage` and the per-node overrides really follow
 * `theme.audio.byQuestion`, exactly one audio element is ever created, and a
 * choice genuinely changes which nodes the participant sees.
 */

const SURVEY_ID = 118;
// 对外域名（国内可达）。源站 emoe.eu.cc 是 Cloudflare 直连地址，国内 SNI 阻断，
// 只作为 Vercel 中继的上游存在 —— QA 应该打用户真正点得开的那个。
const PROD = process.env.QA_PROD_ORIGIN ?? "https://emoemok.top";
const SHOTS = "qa/artifacts/galgame-118";

// 首次运行需要把 25 个素材（约 15MB）拉下来落盘缓存，给本文件更宽的预算
test.describe.configure({ timeout: 240_000 });

/** Every media id the definition references, used to warm the replay cache. */
function mediaPaths(): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("/api/survey/media/")) urls.push(value);
  };
  push(definition.theme?.background?.image);
  push(definition.theme?.audio?.url);
  for (const url of Object.values(definition.theme?.audio?.byPage ?? {})) push(url);
  for (const url of Object.values(definition.theme?.audio?.byQuestion ?? {})) push(url);
  for (const url of Object.values(definition.theme?.audio?.sfx ?? {})) push(url);
  for (const url of Object.values(definition.theme?.sprite?.expressions ?? {})) push(url);
  for (const question of definition.questions) {
    for (const media of question.media ?? []) push(media.url);
  }
  return [...new Set(urls)];
}

const idOf = (url: string | undefined): string | undefined =>
  typeof url === "string" ? /\/api\/survey\/media\/(\d+)$/.exec(url)?.[1] : undefined;

/** BGM only (no UI cues) — the tracks a page turn is expected to switch. */
function bgmIds(): string[] {
  const audio = definition.theme?.audio;
  const urls = [audio?.url, ...Object.values(audio?.byPage ?? {}), ...Object.values(audio?.byQuestion ?? {})];
  return [...new Set(urls.map((url) => idOf(url)).filter((id): id is string => Boolean(id)))];
}

function spriteIds(): string[] {
  const urls = Object.values(definition.theme?.sprite?.expressions ?? {});
  return [...new Set(urls.map((url) => idOf(url)).filter((id): id is string => Boolean(id)))];
}

/**
 * Which MIME prefix each referenced media id must answer with, derived from the
 * definition. A media id the definition never mentions (an unexpected request)
 * maps to nothing and is reported as a problem by the suite.
 */
function expectedMimeById(): Map<string, string> {
  const expected = new Map<string, string>();
  const add = (url: string | undefined, mime: string) => {
    const id = idOf(url);
    if (id) expected.set(id, mime);
  };
  const audio = definition.theme?.audio;
  add(audio?.url, "audio/");
  for (const url of Object.values(audio?.byPage ?? {})) add(url, "audio/");
  for (const url of Object.values(audio?.byQuestion ?? {})) add(url, "audio/");
  for (const url of Object.values(audio?.sfx ?? {})) add(url, "audio/");
  for (const url of Object.values(definition.theme?.sprite?.expressions ?? {})) add(url, "image/webp");
  add(definition.theme?.background?.image, "image/");
  for (const question of definition.questions) {
    for (const media of question.media ?? []) add(media.url, "image/");
  }
  return expected;
}

interface Option {
  id: number;
  label: string;
}
interface Question {
  id: number;
  type: string;
  title: string;
  description?: string | null;
  required: boolean | null;
  pageId: number | null;
  order: number;
  options: Option[];
  media?: Array<{ url?: string; alt?: string }>;
  condition: {
    kind?: string;
    rules?: Array<{ optionId: number; targetQuestionId: number }>;
    answerRules?: Array<{ questionId: number; equals: number; targetQuestionId: number }>;
  } | null;
}
interface Definition {
  id: number;
  title: string;
  pages: Array<{ id: number; title: string }>;
  questions: Question[];
  theme: {
    background?: { image?: string };
    audio?: {
      url?: string;
      byPage?: Record<string, string>;
      byQuestion?: Record<string, string>;
      sfx?: Record<string, string>;
    };
    sprite?: {
      name?: string;
      default?: string;
      expressions?: Record<string, string>;
      byPage?: Record<string, string>;
      byQuestion?: Record<string, string>;
    };
    completion?: { message?: string };
  } | null;
}

const definition = JSON.parse(readFileSync("qa/fixtures/galgame-118.json", "utf-8")) as Definition;

/**
 * Production media is fetched once per test file and replayed for every test,
 * so a five-test suite does not hammer the live origin (and so a slow round trip
 * cannot make a later assertion flaky).
 */
type MediaEntry = { status: number; contentType: string; body: Buffer };

/** 磁盘缓存：首次运行落盘，之后重跑不再打生产（也不会因回程慢而抖动）。 */
const MEDIA_CACHE_DIR = "qa/.media-cache";
const mediaCache = new Map<string, MediaEntry>();

/** 生产媒体对默认的脚本类 User-Agent 会返回 403，必须带浏览器 UA。 */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function diskEntry(path: string): MediaEntry | undefined {
  const id = /\/api\/survey\/media\/(\d+)$/.exec(path)?.[1];
  if (!id) return undefined;
  try {
    const meta = JSON.parse(readFileSync(`${MEDIA_CACHE_DIR}/${id}.json`, "utf-8")) as {
      contentType: string;
    };
    return { status: 200, contentType: meta.contentType, body: readFileSync(`${MEDIA_CACHE_DIR}/${id}.bin`) };
  } catch {
    return undefined;
  }
}

async function loadMedia(path: string): Promise<MediaEntry> {
  const cached = mediaCache.get(path) ?? diskEntry(path);
  if (cached) {
    mediaCache.set(path, cached);
    return cached;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const upstream = await fetch(`${PROD}${path}`, { headers: { "user-agent": BROWSER_UA } });
      if (upstream.status !== 200) throw new Error(`${path} → HTTP ${upstream.status}`);
      const entry: MediaEntry = {
        status: 200,
        contentType: upstream.headers.get("content-type") ?? "application/octet-stream",
        body: Buffer.from(await upstream.arrayBuffer()),
      };
      mediaCache.set(path, entry);
      const id = /\/api\/survey\/media\/(\d+)$/.exec(path)?.[1];
      if (id) {
        mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
        writeFileSync(`${MEDIA_CACHE_DIR}/${id}.bin`, entry.body);
        writeFileSync(
          `${MEDIA_CACHE_DIR}/${id}.json`,
          JSON.stringify({ contentType: entry.contentType, bytes: entry.body.length }),
        );
      }
      return entry;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

const TELEGRAM_STUB = `
window.Telegram = { WebApp: { initData: "", ready() {}, expand() {}, close() { window.__bridgeClosed = 1; } } };
`;

/** Mirrors SurveyApp's nextIndex: option rules first, then answer rules, else linear. */
function nextIndex(
  questions: Question[],
  byId: Map<number, number>,
  currentIndex: number,
  selected: number | undefined,
  answers: Record<number, number>,
): number {
  const current = questions[currentIndex]!;
  const condition = current.condition;
  if (condition) {
    if (selected !== undefined) {
      const rule = (condition.rules ?? []).find((item) => item.optionId === selected);
      const target = rule ? byId.get(rule.targetQuestionId) : undefined;
      if (target !== undefined && target > currentIndex) return target;
    }
    for (const rule of condition.answerRules ?? []) {
      if (answers[rule.questionId] !== rule.equals) continue;
      const target = byId.get(rule.targetQuestionId);
      if (target !== undefined && target > currentIndex) return target;
    }
  }
  return currentIndex + 1;
}

/** The UI renders long multi-line titles; a short normalised prefix identifies the node. */
function heading(title: string): string {
  const line = title.split("\n").map((part) => part.trim()).filter(Boolean)[0] ?? title;
  return line.slice(0, 18);
}

async function installRoutes(page: Page): Promise<string[]> {
  const aborted: string[] = [];

  // Registered first: Playwright matches routes in reverse, so this only sees
  // requests the specific handlers below intentionally leave alone.
  await page.route("**/api/**", (route) => {
    aborted.push(route.request().url());
    return route.abort();
  });
  await page.route("**://telegram.org/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: TELEGRAM_STUB }),
  );
  // Real production artwork/audio, re-served from the page origin so the BGM
  // `fetch()` is not blocked by CORS on a non-production origin.
  await page.route("**/api/survey/media/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const upstream = await loadMedia(path);
    await route.fulfill({ status: upstream.status, contentType: upstream.contentType, body: upstream.body });
  });
  // The survey offers to link the anonymous run to a Telegram account; the
  // participant here stays anonymous.
  await page.route("**/api/survey/participant-link/**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ linked: false }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(definition) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ responseId: 1, resumed: false, currentQuestionId: null }),
    }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1/answers`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1/submit`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, completed: true }) }),
  );
  await page.route(`**/api/survey/${SURVEY_ID}/responses/1`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ answers: {} }) }),
  );
  // 单卷结局图鉴（0086）：完成页会拉一次。这条路一加，`**/api/**` 的兜底
  // abort 就不再把「没建模的接口」算成问题——但反过来，一旦完成页真的去拉它，
  // 这个 mock 必须存在，否则 aborted 非空、测试失败（这正是它当初红的原因）。
  await page.route(`**/api/survey/${SURVEY_ID}/endings`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        unlocked: [{ endingKey: "lamplight", resultType: "chapter", title: "台灯与手稿", unlockedAt: "2026-08-23T12:00:00Z" }],
        total: 4,
        hasGallery: true,
      }),
    }),
  );

  // Instrumentation: every `new Audio()` the app creates, plus which of those
  // elements actually received a track, so player duplication and per-page
  // track switching stay observable now that music is streamed from the media
  // endpoint instead of being fetched into a blob URL.
  await page.addInitScript(() => {
    (window as unknown as { __audios: unknown[] }).__audios = [];
    (window as unknown as { __trackedPlayers: unknown[] }).__trackedPlayers = [];
    const Native = window.Audio;
    const spy = function (this: unknown, src?: string) {
      const audio = new Native(src);
      (window as unknown as { __audios: unknown[] }).__audios.push(audio);
      return audio;
    } as unknown as typeof Audio;
    spy.prototype = Native.prototype;
    window.Audio = spy;
    // A player is identified by the element that receives a track: the per-page
    // BGM must reuse one element, so only one element may ever be handed a
    // source — and it may only be handed one after the participant asks for
    // sound.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (descriptor?.set && descriptor.get) {
      const { get, set } = descriptor;
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get,
        set(this: HTMLMediaElement & { __trackedTrack?: boolean }, value: string) {
          if (String(value) && !this.__trackedTrack) {
            this.__trackedTrack = true;
            (window as unknown as { __trackedPlayers: unknown[] }).__trackedPlayers.push(this);
          }
          return set.call(this, value);
        },
      });
    }

    (window as unknown as { __fetched: string[] }).__fetched = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      (window as unknown as { __fetched: string[] }).__fetched.push(url);
      return nativeFetch(input, init);
    };

    // The UI sound effects run through one lazily-created AudioContext. Count
    // constructions so the suite can prove nothing spins one up before a real
    // gesture (the autoplay policy) and that a session never creates a second
    // engine alongside the music player.
    const contexts: unknown[] = [];
    (window as unknown as { __audioContexts: unknown[] }).__audioContexts = contexts;
    const NativeContext = window.AudioContext;
    if (NativeContext) {
      const Spy = function (this: unknown, ...args: unknown[]) {
        const context = new (NativeContext as unknown as new (...rest: unknown[]) => AudioContext)(...args);
        contexts.push(context);
        return context;
      } as unknown as typeof AudioContext;
      Spy.prototype = NativeContext.prototype;
      window.AudioContext = Spy;
    }
  });

  return aborted;
}

async function fetchedMedia(page: Page): Promise<string[]> {
  const urls = await page.evaluate(() => (window as unknown as { __fetched: string[] }).__fetched ?? []);
  const ids = new Set<string>();
  for (const url of urls) {
    const match = /\/api\/survey\/media\/(\d+)/.exec(url);
    if (match) ids.add(match[1]!);
  }
  return [...ids];
}

/**
 * How many audio elements were ever handed a track.
 *
 * The audio-fingerprinting vendor also constructs bare `Audio` objects to probe
 * codec support, so counting constructions would be noise; what matters is
 * whether a *second* player ever received a source, and whether any player was
 * allowed to load the music before the participant turned sound on.
 */
async function trackedPlayerCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trackedPlayers: unknown[] }).__trackedPlayers.length);
}

async function assertIllustrationsRender(page: Page): Promise<void> {
  // 插图是 `loading="lazy"` 的：落在视口下方的图会合理地推迟解码，所以先滚到底把
  // 它们带进视口——断言要证明的是"这张图能渲染"，而不是"没滚屏时它也已经解码"。
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // 图片走 fetch → blob URL，挂上 <img> 后仍有一小段解码期（naturalWidth 暂为 0）。
  // 先给一个有界等待窗口，再硬断言：真损坏的图仍然会失败，只是不再被解码延迟误判。
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("main img")).every((node) => {
          const src = node.getAttribute("src");
          return !src || (node as HTMLImageElement).naturalWidth > 0;
        }),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  const images = await page.locator("main img").evaluateAll((nodes) =>
    nodes.map((node) => {
      const image = node as HTMLImageElement;
      return { src: image.getAttribute("src") ?? "", width: image.naturalWidth, height: image.naturalHeight };
    }),
  );
  for (const image of images) {
    if (!image.src) continue;
    expect(image.width, `插图未渲染：${image.src}`).toBeGreaterThan(0);
    expect(image.height, `插图未渲染：${image.src}`).toBeGreaterThan(0);
  }
}

interface PlayResult {
  visited: string[];
  /** Node ids, because a title such as "合上这一夜——" is shared by four nodes. */
  visitedIds: number[];
  skippedIds: number[];
  pages: string[];
}

/**
 * Drives the real UI through the story, following the same navigation rules the
 * engine uses, and asserts the rendered node matches the one the model expects
 * at every step (so a wrong jump fails loudly instead of silently passing).
 */
async function play(
  page: Page,
  options: { gateOptionIndex: number; stopWhenOffered: boolean; slug: string },
): Promise<PlayResult> {
  const questions = definition.questions;
  const byId = new Map(questions.map((q, index) => [q.id, index]));
  const visited: string[] = [];
  const visitedIds: number[] = [];
  const skippedIds: number[] = [];
  const pagesSeen: string[] = [];
  const answers: Record<number, number> = {};

  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator("main")).toContainText(heading(questions[0]!.title));
  // The opening page carries the title track; give the real download the moment
  // a reader would spend on the first page.
  if (definition.theme?.audio?.byPage?.["0"] ?? definition.theme?.audio?.url) {
    await expect(page.getByRole("button", { name: /声音/ })).toBeVisible({ timeout: 20000 });
  }

  mkdirSync(SHOTS, { recursive: true });

  let index = 0;
  for (let guard = 0; index < questions.length && guard <= questions.length + 10; guard++) {
    const question = questions[index]!;
    visited.push(question.title);
    visitedIds.push(question.id);
    const pageTitle = definition.pages.find((item) => item.id === question.pageId)?.title;
    if (pageTitle && pagesSeen[pagesSeen.length - 1] !== pageTitle) {
      pagesSeen.push(pageTitle);
      // The header renders the current page (chapter) title, so a chapter
      // change is visible to the participant, not just internal state.
      await expect(page.locator("body")).toContainText(pageTitle);
    }

    await expect(page.locator("main")).toContainText(heading(question.title));
    await assertIllustrationsRender(page);
    await page.screenshot({
      path: `${SHOTS}/${options.slug}-${String(visited.length).padStart(2, "0")}.png`,
      fullPage: false,
    });

    let selected: number | undefined;
    if (question.type === "long_text") {
      // The final question asks the reader to write a line of their own.
      const field = page.locator("main textarea, main input[type=text]").first();
      await field.fill("晚安，晚棠。");
      // A focused field keeps the nav bar tucked away (`translate-y-full`) so
      // the on-screen keyboard has room; blur before pressing the button.
      await field.evaluate((node) => (node as HTMLElement).blur());
      answers[question.id] = 1;
    } else if (question.type !== "note" && question.options.length > 0) {
      const isGate = question.title.includes("四个开场");
      const stop = options.stopWhenOffered
        ? question.options.find((option) => option.label.startsWith("停在这里"))
        : undefined;
      const chosen = stop ?? (isGate ? question.options[options.gateOptionIndex]! : question.options[0]!);
      selected = chosen.id;
      answers[question.id] = chosen.id;
      await page.getByRole("button", { name: chosen.label }).first().click();
    }

    const nav = page.locator("nav button.btn-primary");
    const navLabel = question.type === "note" ? "继续" : index === questions.length - 1 ? "提交问卷" : "下一题";
    await expect(nav).toContainText(navLabel);
    await nav.click();

    const next = nextIndex(questions, byId, index, selected, answers);
    for (let between = index + 1; between < next; between++) skippedIds.push(questions[between]!.id);
    index = next;
  }

  expect(index, "playthrough must reach the ending").toBeGreaterThanOrEqual(questions.length);
  const ending = definition.theme?.completion?.message;
  if (ending) await expect(page.locator("body")).toContainText(ending.slice(0, 12));

  return { visited, visitedIds, skippedIds, pages: pagesSeen };
}

// Fetching the real artwork and music once per run keeps the walk below the
// production round-trip time, so a page turn cannot cancel an in-flight track
// load. (That cancellation is a real property of the player: see the note in
// the final report.)
test.beforeAll(async () => {
  // 25 个素材约 15MB：并发预热，落盘后重跑几乎不耗时
  await Promise.all(mediaPaths().map((url) => loadMedia(url)));
});

test("production survey 118 plays from the prologue to an ending", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${String(error)}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  const mediaTypes: string[] = [];
  const expectedMime = expectedMimeById();
  page.on("response", (response: Response) => {
    const url = response.url();
    const match = /\/api\/survey\/media\/(\d+)$/.exec(url);
    if (!match) return;
    if (response.status() !== 200) {
      problems.push(`media HTTP ${response.status()} ${url}`);
      return;
    }
    const type = response.headers()["content-type"] ?? "";
    mediaTypes.push(`${match[1]}:${type}`);
    const expected = expectedMime.get(match[1]!);
    // A media id the definition never mentions means the page invented a
    // request; a wrong prefix means the stored MIME is lying about the bytes.
    if (!expected) problems.push(`请求了定义里没有的媒体 ${url}`);
    else if (!type.startsWith(expected)) problems.push(`媒体 MIME 错误 ${url} -> ${type}（应为 ${expected}）`);
  });

  const aborted = await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const result = await play(page, { gateOptionIndex: 0, stopWhenOffered: false, slug: "route-a" });

  // The reader walks a complete storyline: 18+ narrative nodes really rendered
  // (the VN is not a stub), here the 22 nodes of the "台灯与手稿" route.
  expect(result.visited.length).toBeGreaterThanOrEqual(18);
  expect(result.visited.length).toBe(22);

  // The opening choice forks the story at page level: this route walks the
  // prologue, chapter one, its own route chapter and the epilogue, and never
  // renders the other three route chapters.
  expect(result.pages).toHaveLength(4);
  expect(result.pages).toContain("慢热线 · 台灯与手稿");
  for (const other of ["距离线 · 隔座的月光", "深入线 · 凌晨三点的语音条", "默契线 · 猫、外卖与碎碎念"]) {
    expect(result.pages, `不该走到其它路线：${other}`).not.toContain(other);
  }

  // 完成页的结局图鉴（0086）：/endings 被真的请求并消费，而不是被兜底 abort。
  // 没有这条断言，mock 只是让红色变绿；有了它，接口回归会重新变红。
  await expect(page.locator("body")).toContainText("结局图鉴");
  await expect(page.locator("body")).toContainText("1/4");

  // A run that never asks for sound must not download a single note: each cue
  // here is 1.1–1.6MB, and pulling them unasked is what made the survey crawl
  // on a mobile link. How the map behaves once sound is on is the next test.
  const tracks = await fetchedMedia(page);
  const bgmTrackIds = bgmIds();
  expect(
    tracks.filter((id) => bgmTrackIds.includes(id)),
    "声音未开启时不应下载任何 BGM",
  ).toEqual([]);

  // Phase 6: no music element was handed a track before the participant asked
  // for one — the whole point of gating playback on the toggle.
  expect(await trackedPlayerCount(page), "声音未开启时不应创建音乐播放器").toBe(0);

  // Phase 5/6: real bytes, correct MIME, no 404 and no wrong-typed response.
  expect(mediaTypes.some((entry) => entry.includes("audio/")), `未观察到音频响应：${mediaTypes.join(",")}`).toBe(true);
  expect(mediaTypes.some((entry) => entry.includes("image/")), `未观察到图片响应：${mediaTypes.join(",")}`).toBe(true);
  // Nothing hit an endpoint this suite did not model.
  expect(aborted, `出现了未预期的接口调用：${aborted.join(",")}`).toEqual([]);
  expect(problems).toEqual([]);
});

test("declining the intimate chapter really skips it, and both routes still reach an ending", async ({ page }) => {
  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });

  // Same opening, same route — the only difference is whether the participant
  // accepts or declines when the story asks for consent.
  const continued = await play(page, { gateOptionIndex: 0, stopWhenOffered: false, slug: "consent-yes" });
  const declined = await play(page, { gateOptionIndex: 0, stopWhenOffered: true, slug: "consent-stop" });

  // A picked option's jump target must never also have been rendered: the nodes
  // the model skipped are exactly the nodes the participant did not read.
  for (const walked of [continued, declined]) {
    for (const id of walked.skippedIds) {
      expect(walked.visitedIds, `被跳过的节点不该出现：${id}`).not.toContain(id);
    }
  }

  // Declining removes the intimate chapter and shortens the run...
  expect(declined.visitedIds.length).toBeLessThan(continued.visitedIds.length);
  const intimateId = definition.questions.find((question) => question.title.includes("批注（口述版）"))!.id;
  expect(continued.visitedIds, "接受时应读到批注章节").toContain(intimateId);
  expect(declined.visitedIds).not.toContain(intimateId);

  // ...while the crisis and the ending stay reachable for both.
  const crisisIds = new Set(
    definition.questions.filter((question) => question.title.includes("失联")).map((question) => question.id),
  );
  expect(crisisIds.size).toBeGreaterThan(0);
  expect(declined.visitedIds.some((id) => crisisIds.has(id))).toBe(true);
  expect(declined.pages).toContain(definition.pages[definition.pages.length - 1]!.title);
});

test("BGM is downloaded only after the sound toggle, then follows the page and node map", async ({ page }) => {
  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // 音乐现在由 <audio src> 自己流式加载，不经过 window.fetch，所以这里按网络请求
  // 观测（与 fetch 钩子那套并行存在）。
  const requestedMedia: string[] = [];
  page.on("request", (request) => {
    const match = /\/api\/survey\/media\/(\d+)/.exec(request.url());
    if (match) requestedMedia.push(match[1]!);
  });
  await page.goto(`/s/${SURVEY_ID}`);

  const bgmTrackIds = bgmIds();
  const heardTracks = async () => [...new Set(requestedMedia.filter((id) => bgmTrackIds.includes(id)))];

  // The toggle is on screen from the first node, and nothing has been
  // downloaded for it: the button is a control, not a download trigger.
  const toggle = page.getByRole("button", { name: "开启声音" });
  await expect(toggle).toBeVisible({ timeout: 20000 });
  await expect(page.locator("main")).toContainText(heading(definition.questions[0]!.title));
  expect(await heardTracks(), "打开问卷时不应下载 BGM").toEqual([]);
  expect(await trackedPlayerCount(page), "打开问卷时不应创建音乐播放器").toBe(0);

  // Turning sound on is what pulls the first track — and it must actually play.
  await toggle.click();
  await expect(page.getByRole("button", { name: "关闭声音" })).toBeVisible();
  await expect.poll(async () => (await heardTracks()).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const firstTrack = (await heardTracks())[0]!;
  expect(await trackedPlayerCount(page), "开启声音应只创建一个播放器").toBe(1);

  // Walking to the next node that carries its own cue must switch the track on
  // the SAME player: the byPage/byQuestion map is consumed, not just stored.
  // Those overrides are keyed by node order, so the walk has to genuinely reach
  // them — answering each node on the way, exactly as a reader would.
  const cueIds = new Set(
    Object.values(definition.theme?.audio?.byQuestion ?? {})
      .map((url) => idOf(url))
      .filter((id): id is string => Boolean(id)),
  );
  const questions = definition.questions;
  const byId = new Map(questions.map((question, index) => [question.id, index]));
  const answers: Record<number, number> = {};
  let index = 0;
  while (index < questions.length && !(await heardTracks()).some((id) => cueIds.has(id))) {
    const question = questions[index]!;
    let selected: number | undefined;
    if (question.type !== "note" && question.options.length > 0) {
      selected = question.options[0]!.id;
      answers[question.id] = selected;
      await page.getByRole("button", { name: question.options[0]!.label }).first().click();
    }
    await page.locator("nav button.btn-primary").click();
    index = nextIndex(questions, byId, index, selected, answers);
  }
  const afterWalk = await heardTracks();
  expect(
    afterWalk.filter((id) => cueIds.has(id)).length,
    `节点级 BGM 未被请求，实际听到 ${afterWalk.join(",")}`,
  ).toBeGreaterThan(0);
  expect(await trackedPlayerCount(page), "换曲不应再创建一个播放器元素").toBe(1);

  // Toggling off stops playback (and silences the interface cues with it).
  await page.getByRole("button", { name: "关闭声音" }).click();
  await expect(page.getByRole("button", { name: "开启声音" })).toBeVisible();
  expect(await trackedPlayerCount(page), "关闭声音不应产生第二个播放器").toBe(1);
});

test("the interface sound effects are wired, gesture-gated and never stack a player", async ({ page }) => {
  const sfx = definition.theme?.audio?.sfx ?? {};
  // The cue names are the contract with `src/survey/theme.ts`: a rename on
  // either side must fail here rather than silently going mute.
  expect(Object.keys(sfx).sort()).toEqual(["cancel", "confirm", "page", "select", "transition"]);

  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator("main")).toContainText(heading(definition.questions[0]!.title));

  // Autoplay policy: before the participant touches anything there is no audio
  // engine and no cue has been fetched — the first gesture is what unlocks it.
  expect(
    await page.evaluate(() => (window as unknown as { __audioContexts: unknown[] }).__audioContexts.length),
    "首个手势之前不应创建 AudioContext",
  ).toBe(0);
  expect((await fetchedMedia(page)).filter((id) => Object.values(sfx).some((url) => idOf(url) === id))).toEqual([]);

  const cueIds = Object.values(sfx).map((url) => idOf(url)).filter((id): id is string => Boolean(id));
  const waitForCues = async (minimum: number) => {
    await expect
      .poll(async () => (await fetchedMedia(page)).filter((id) => cueIds.includes(id)).length, {
        timeout: 15_000,
        message: "界面音效未被请求",
      })
      .toBeGreaterThanOrEqual(minimum);
  };
  const cueIdsFor = (...cues: string[]) =>
    cues.map((cue) => idOf(sfx[cue])).filter((id): id is string => Boolean(id));

  // Navigating is a gesture: the page-turn cue must actually be requested.
  await page.locator("nav button.btn-primary").click();
  await waitForCues(1);
  expect(
    await page.evaluate(() => (window as unknown as { __audioContexts: unknown[] }).__audioContexts.length),
    "首次手势后应建立一个 AudioContext",
  ).toBe(1);
  const afterNav = await fetchedMedia(page);
  expect(
    afterNav.some((id) => cueIdsFor("page", "transition").includes(id)),
    `翻页时未请求任何翻页音效，实际 ${afterNav.join(",")}`,
  ).toBe(true);

  // Picking an option is the other cue: walk to the first node that offers one.
  const questions = definition.questions;
  let index = 0;
  while (index < questions.length && !(questions[index]!.type !== "note" && questions[index]!.options.length > 0)) {
    await page.locator("nav button.btn-primary").click();
    index += 1;
  }
  expect(index, "找不到任何带选项的节点").toBeLessThan(questions.length);
  const chosen = questions[index]!.options[0]!;
  await page.getByRole("button", { name: chosen.label }).first().click();
  await expect
    .poll(async () => (await fetchedMedia(page)).some((id) => cueIdsFor("select").includes(id)), {
      timeout: 15_000,
      message: "选中选项时未请求选择音效",
    })
    .toBe(true);

  // Audio is a singleton: adding the effects engine must not add a second
  // music element, and one context is enough for the whole session. The cues
  // ride the AudioContext, so sound being off in this test means the music
  // player must not even exist.
  expect(
    await page.evaluate(() => (window as unknown as { __audioContexts: unknown[] }).__audioContexts.length),
    "同一会话只应有一个 AudioContext",
  ).toBe(1);
  expect(await trackedPlayerCount(page), "音效引擎不应创建音乐播放器元素").toBe(0);

  // Every cue is a real MP3 on the wire, not a placeholder path.
  for (const [cue, url] of Object.entries(sfx)) {
    const media = await loadMedia(new URL(url, PROD).pathname);
    expect(media.status, `${cue} 音效不可达`).toBe(200);
    expect(media.contentType, `${cue} 音效 MIME 异常`).toContain("audio/");
    expect(media.body.length, `${cue} 音效为空文件`).toBeGreaterThan(500);
  }
  expect(new Set(Object.values(sfx)).size, "5 条音效必须各自独立").toBe(5);
});

test("the character sprite renders, changes with the scene and stays behind the dialogue", async ({ page }) => {
  const sprite = definition.theme?.sprite;
  const expressions = sprite?.expressions ?? {};
  expect(Object.keys(expressions).length, "立绘表情表为空").toBe(11);

  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const requestedMedia: string[] = [];
  page.on("request", (request) => {
    const match = /\/api\/survey\/media\/(\d+)/.exec(request.url());
    if (match) requestedMedia.push(match[1]!);
  });
  await page.goto(`/s/${SURVEY_ID}`);

  const layer = page.locator("[data-survey-sprite]");
  await expect(layer).toHaveCount(1);
  const opening = await layer.getAttribute("data-survey-sprite");
  expect(Object.keys(expressions)).toContain(opening);
  expect(sprite?.byPage?.["0"], "首页没有默认表情").toBe(opening);

  // The WebP really decodes in the browser (356x1100 with alpha upstream): a
  // URL in the database is not evidence that the reader sees anything.
  const image = layer.locator("img");
  await expect
    .poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);
  const box = await image.boundingBox();
  expect(box?.height ?? 0, "立绘渲染高度为 0").toBeGreaterThan(120);
  await expect(image).toHaveAttribute("alt", new RegExp(sprite?.name ?? "立绘"));

  // The expression is scene-driven, so it is checked against the model node by
  // node: the prologue alone carries three node-level emotions (order 3 soft,
  // 4 smile, 6 sad), and every one of them must win over the page default.
  const expectedExpression = (order: number): string | undefined => {
    const question = definition.questions.find((item) => item.order === order);
    const pageIndex = question ? definition.pages.findIndex((page) => page.id === question.pageId) : -1;
    return sprite?.byQuestion?.[String(order)] ?? sprite?.byPage?.[String(pageIndex)] ?? sprite?.default;
  };

  const seen = new Set<string>();
  const mismatches: string[] = [];
  for (let index = 0; index < 6; index++) {
    const question = definition.questions[index]!;
    // Drive the real UI: a required choice must be answered before 下一题 opens.
    if (question.type !== "note" && question.options.length > 0) {
      await page.getByRole("button", { name: question.options[0]!.label }).first().click();
    }
    await page.locator("nav button.btn-primary").first().click();
    const expected = expectedExpression(question.order + 1);
    let observed: string | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      observed = await layer.getAttribute("data-survey-sprite").catch(() => null);
      if (observed === expected) break;
      await page.waitForTimeout(200);
    }
    seen.add(String(observed));
    if (observed !== expected) mismatches.push(`order ${question.order + 1}: ${observed} ≠ ${expected}`);
  }
  expect(mismatches, "立绘表情与剧情映射不一致").toEqual([]);
  expect(seen.size, `表情没有随剧情变化：只见 ${[...seen].join(",")}`).toBeGreaterThan(1);

  // The whole emotion table is warmed shortly after the first frame, so a later
  // swap cannot flash white; that also proves all 11 files are reachable. The
  // warm-up goes through `new Image()`, which never touches `fetch`, so this
  // one is observed on the wire instead of on the instrumented fetch.
  const ids = spriteIds();
  const hit = () => new Set(requestedMedia.filter((id) => ids.includes(id))).size;
  await expect.poll(hit, { timeout: 20_000 }).toBe(ids.length);
  expect([...new Set(requestedMedia.filter((id) => ids.includes(id)))].sort()).toEqual([...ids].sort());

  // Desktop keeps the VN convention: the sprite sits *behind* the text card.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(layer).toBeVisible();
  expect(await layer.evaluate((node) => getComputedStyle(node).zIndex), "桌面端立绘必须压在对话框下面（负 z）").toBe(
    "-1",
  );
  expect(await layer.evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
  await page.screenshot({ path: `${SHOTS}/sprite-desktop.png` });
});

test("leaving the survey silences the music", async ({ page }) => {
  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${SURVEY_ID}`);
  const toggle = page.getByRole("button", { name: "开启声音" });
  await expect(toggle).toBeVisible({ timeout: 20000 });
  await toggle.click();
  await expect(page.getByRole("button", { name: "关闭声音" })).toBeVisible();

  // `pagehide` is what fires when the participant leaves, goes back, or the
  // Mini App host closes the view; it must stop the track even though React
  // never unmounts. (`qa/visual/survey-exit.spec.ts` proves the navigation
  // itself happens; this proves the audio lifecycle hook that pairs with it.)
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const paused = await page.evaluate(
    () => (window as unknown as { __audios: Array<{ paused: boolean }> }).__audios.every((audio) => audio.paused),
  );
  expect(paused, "离开后 BGM 仍在播放").toBe(true);
});

test("the whole script is written prose, not filler", async ({ page }) => {
  // The prose is split between the prompt (`title`) and the narrative
  // paragraphs (`description`); the reader reads both. This is the WHOLE
  // script (all 58 nodes across all four route pages) — it is deliberately not
  // used as the play-length measure, because a single run walks only 22 of
  // those nodes. See the next test for the per-run volume.
  const paragraphs = definition.questions.filter((question) => (question.description ?? "").length > 0);
  const text = definition.questions
    .map((question) => `${question.title}\n${question.description ?? ""}`)
    .join("\n");
  expect(paragraphs.length, "全稿叙事段落数量").toBeGreaterThanOrEqual(30);
  expect(text.length, "全稿叙事体量").toBeGreaterThan(4000);
  expect(text).toContain("晚棠");

  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${SURVEY_ID}`);
  await expect(page.locator("main")).toContainText("晚棠");
  // The chapter title is visible, so the reader always knows where they are.
  await expect(page.locator("body")).toContainText(definition.pages[0]!.title);
});

test("a single run reads one route page, and the sitting volume is recorded", async ({ page }) => {
  // The gate picks ONE of four mutually exclusive route pages, so a sitting
  // reads 22 of the 58 nodes. Measuring the volume on the walked path (not on
  // the whole script) is what keeps the length claim honest.
  await installRoutes(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const walked = await play(page, { gateOptionIndex: 0, stopWhenOffered: false, slug: "volume" });
  const byId = new Map(definition.questions.map((question) => [question.id, question]));
  const narrative = walked.visitedIds.reduce((total, id) => {
    const question = byId.get(id)!;
    return total + (question.title ?? "").length + (question.description ?? "").length;
  }, 0);
  const choices = walked.visitedIds.reduce(
    (total, id) => total + byId.get(id)!.options.reduce((sum, option) => sum + option.label.length, 0),
    0,
  );
  test.info().annotations.push({
    type: "reading-volume",
    description:
      `节点 ${walked.visitedIds.length} · 叙事 ${narrative} 字 · 选项 ${choices} 字 · ` +
      `合计 ${narrative + choices} 字 · 约 ${Math.round((narrative + choices) / 300)} 分钟纯阅读`,
  });
  expect(walked.visitedIds.length, "单次通关节点数").toBeGreaterThanOrEqual(18);
  expect(narrative, "单次通关叙事体量").toBeGreaterThan(1500);
});

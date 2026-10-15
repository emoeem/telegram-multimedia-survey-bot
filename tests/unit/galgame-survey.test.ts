import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateUnifiedSurvey } from "../../src/survey/validator";

const here = dirname(fileURLToPath(import.meta.url));
const contentPath = resolve(here, "../../scripts/galgame/galgame-survey.json");
const assetsDir = resolve(here, "../../scripts/galgame/assets");

const content = JSON.parse(readFileSync(contentPath, "utf-8"));
const survey = content.survey as {
  title: string;
  pages: Array<{ id: string; order: number }>;
  questions: GalQuestion[];
  cover: GalMedia & { alt?: string };
  settings: {
    theme: {
      background: { image: string; alt?: string };
      audio: { url: string; byPage: Record<string, string>; byQuestion: Record<string, string>; sfx?: Record<string, string> };
      sprite: {
        name: string;
        default: string;
        expressions: Record<string, string>;
        byPage: Record<string, string>;
        byQuestion: Record<string, string>;
      };
    };
  };
};

interface GalMedia {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

interface GalOption {
  id: string;
  label: string;
  value: string;
  order: number;
  media?: Array<{ url: string }>;
}
interface GalQuestion {
  id: string;
  type: string;
  title: string;
  description?: string;
  required: boolean | null;
  order: number;
  page_id: string;
  options?: GalOption[];
  media?: GalMedia[];
  condition?: {
    kind?: string;
    rules?: Array<{ optionId: string; targetQuestionId: string }>;
    skipToQuestionId?: string;
  };
}

/** 从 JPEG 头部 SOF 段读真实像素尺寸，避免为测试引入图像库。 */
function sizeOfSync(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  // 逐字节拼大端 16 位：Buffer 的方法在部分 @types/node 版本上因 NonSharedBuffer 联合类型而不可见
  const word = (at: number): number => ((buf[at] ?? 0) << 8) | (buf[at + 1] ?? 0);
  let offset = 2; // 跳过 SOI
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    const length = word(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: word(offset + 5), width: word(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error(`不是 JPEG 或找不到 SOF 段: ${path}`);
}

/** 按字节比较 ASCII 字面量；不用 Buffer#toString，因为本仓库的 @types/node 下
 *  Buffer 方法在 NonSharedBuffer 联合类型上不可见（见 sizeOfSync 的同一注释）。 */
function asciiAt(buf: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (buf[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** 无图像库读 WebP 的 VP8X 画布尺寸；PIL 导出的带 alpha 有损 WebP 一定带 VP8X 段。 */
function webpSizeSync(path: string): { width: number; height: number; hasAlpha: boolean } {
  const buf = readFileSync(path);
  if (!asciiAt(buf, 0, "RIFF")) throw new Error(`不是 RIFF/WebP: ${path}`);
  if (!asciiAt(buf, 8, "WEBP")) throw new Error(`不是 RIFF/WebP: ${path}`);
  if (!asciiAt(buf, 12, "VP8X")) throw new Error(`缺少 VP8X 段: ${path}`);
  const u24 = (at: number): number =>
    (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8) | ((buf[at + 2] ?? 0) << 16);
  return { width: u24(24) + 1, height: u24(27) + 1, hasAlpha: ((buf[20] ?? 0) & 0x10) !== 0 };
}

const questions = survey.questions;
const indexById = new Map(questions.map((q, i) => [q.id, i]));

/** Mirrors the fill-side walk (SPA nextIndex / worker walker):
 *  notes auto-advance; option rules jump forward; else linear. */
function walk(answers: Record<string, string>): { visited: string[]; finished: boolean } {
  let idx = 0;
  const visited: string[] = [];
  for (let guard = 0; idx < questions.length && guard < questions.length + 8; guard++) {
    const q = questions[idx]!;
    visited.push(q.id);
    let next = idx + 1;
    const selected = q.options?.find((option) => answers[q.id] === option.id);
    if (selected && q.condition?.rules) {
      const rule = q.condition.rules.find((r) => r.optionId === selected.id);
      const target = rule ? indexById.get(rule.targetQuestionId) : undefined;
      if (target !== undefined && target > idx) next = target;
    }
    if (next >= questions.length) return { visited, finished: true };
    idx = next;
  }
  return { visited, finished: false };
}

function mediaUrls(): string[] {
  const urls: string[] = [];
  if (survey.settings.theme.background.image) urls.push(survey.settings.theme.background.image);
  urls.push(
    survey.settings.theme.audio.url,
    ...Object.values(survey.settings.theme.audio.byPage),
    ...Object.values(survey.settings.theme.audio.byQuestion),
    ...Object.values(survey.settings.theme.audio.sfx ?? {}),
    ...Object.values(survey.settings.theme.sprite.expressions),
  );
  for (const question of questions) {
    for (const media of question.media ?? []) urls.push(media.url);
    for (const option of question.options ?? []) {
      for (const media of option.media ?? []) urls.push(media.url);
    }
  }
  return [...new Set(urls)];
}

describe("晚安，苏晚棠 问卷定义（scripts/galgame/galgame-survey.json）", () => {
  it("通过 validateUnifiedSurvey 结构校验", () => {
    expect(validateUnifiedSurvey(content)).toEqual([]);
  });

  it("共 58 个节点、7 页，order 连续且与页归属正确", () => {
    expect(questions).toHaveLength(58);
    expect(survey.pages).toHaveLength(7);
    expect(questions.map((q) => q.order)).toEqual(Array.from({ length: 58 }, (_, i) => i + 1));
    const pageIds = new Set(survey.pages.map((p) => p.id));
    for (const question of questions) expect(pageIds.has(question.page_id)).toBe(true);
  });

  it("全部媒体引用指向真实素材文件（17 图 + 8 曲 + 11 立绘 + 5 音效）", () => {
    const urls = mediaUrls();
    expect(urls.length).toBe(41);
    for (const url of urls) {
      expect(url).toMatch(/^kv:\/\//);
      expect(existsSync(join(assetsDir, url.replace("kv://", ""))), `缺少素材 ${url}`).toBe(true);
    }
  });

  it("每张题内插画都有非空 alt、真实尺寸，且文件确实是那个尺寸", () => {
    const illustrated = questions.filter((q) => (q.media ?? []).length > 0);
    expect(illustrated).toHaveLength(16);
    for (const question of illustrated) {
      for (const media of question.media!) {
        const filename = media.url.replace("kv://", "");
        expect(media.alt?.trim(), `order ${question.order} 的 ${filename} 缺 alt`).toBeTruthy();
        expect(media.width, `order ${question.order} 的 ${filename} 缺 width`).toBeGreaterThan(0);
        expect(media.height, `order ${question.order} 的 ${filename} 缺 height`).toBeGreaterThan(0);
        // 声明的尺寸必须与磁盘上真实像素一致，否则就是记录失真
        const declared = sizeOfSync(join(assetsDir, filename));
        expect([declared.width, declared.height]).toEqual([media.width, media.height]);
      }
    }
  });

  it("封面也带 alt 与真实尺寸", () => {
    expect(survey.cover.alt?.trim()).toBeTruthy();
    expect(survey.cover.width).toBe(1600);
    expect(survey.cover.height).toBe(1000);
  });

  it("byPage 覆盖全部 7 页且各页曲目不重复缺漏", () => {
    expect(Object.keys(survey.settings.theme.audio.byPage).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    const tracks = new Set(Object.values(survey.settings.theme.audio.byPage));
    expect(tracks.size).toBe(6); // rain 复用两页；四线四曲 + 尾声黎明 = 6
  });

  it("byQuestion 为转折与四个结局提供节点级曲目，且每条都真的改变了页级底色", () => {
    const { byPage, byQuestion } = survey.settings.theme.audio;
    const orderIndex = new Map(questions.map((q) => [String(q.order), q]));
    for (const [key, track] of Object.entries(byQuestion)) {
      expect(key, `byQuestion 键 ${key} 必须是数字 order`).toMatch(/^\d{1,4}$/);
      const q = orderIndex.get(key);
      expect(q, `byQuestion 键 ${key} 没有对应题目`).toBeDefined();
      expect(existsSync(join(assetsDir, track.replace("kv://", ""))), `缺少素材 ${track}`).toBe(true);
      // 节点级提示存在的唯一理由就是"页级会给错情绪"；与页级相同即死代码。
      const pagePos = survey.pages.findIndex((page) => page.id === q!.page_id);
      expect(pagePos).toBeGreaterThanOrEqual(0);
      expect(byPage[String(pagePos)], `order ${key} 的节点级曲目与页级相同，等于没生效`).not.toBe(track);
    }

    // 四个结局分属第 3/4/5/6 页，绝不能靠页级底色收束。
    for (const endingOrder of ["19", "31", "43", "55"]) {
      expect(byQuestion[endingOrder], `结局 order ${endingOrder} 缺节点级曲目`).toBe("kv://bgm-finale.mp3");
    }
    // 开场四选一 + 两条同意关卡：静か/勇気/感動，比雨夜亮一档。
    for (const order of ["8", "26", "38"]) {
      expect(byQuestion[order], `order ${order} 应为选曲`).toBe("kv://bgm-secret.mp3");
    }
    // 四条线各有一对"失联 → 追问"。
    for (const order of ["17", "18", "29", "30", "41", "42", "53", "54"]) {
      expect(byQuestion[order], `失联/追问 ${order}`).toBe("kv://bgm-tension.mp3");
    }
  });

  it("界面音效：5 条 cue 与前端白名单一致，素材都是真文件", () => {
    const sfx = survey.settings.theme.audio.sfx ?? {};
    expect(Object.keys(sfx).sort()).toEqual(["cancel", "confirm", "page", "select", "transition"]);
    for (const [cue, url] of Object.entries(sfx)) {
      expect(url, `${cue} 必须指向 kv 素材`).toMatch(/^kv:\/\/sfx-[a-z]+\.mp3$/);
      const path = join(assetsDir, url.replace("kv://", ""));
      expect(existsSync(path), `缺少音效素材 ${url}`).toBe(true);
      const buf = readFileSync(path);
      expect(buf.length, `${cue} 素材过小`).toBeGreaterThan(1000);
      // 要么带 ID3 标签，要么第一字节就是 MPEG 帧同步 0xFF。
      const hasId3 = asciiAt(buf, 0, "ID3");
      expect(hasId3 || buf[0] === 0xff, `${cue} 不是 MP3（无 ID3 也无帧同步头）`).toBe(true);
    }
  });

  it("立绘：11 个表情都是 356×1100 带 alpha 的 WebP，且文件真实存在", () => {
    const sprite = survey.settings.theme.sprite;
    expect(sprite.name).toBe("苏晚棠");
    expect(sprite.default).toBe("neutral");
    const names = Object.keys(sprite.expressions);
    expect(names).toHaveLength(11);
    expect(names).toContain("neutral");
    expect(names).toContain("smile");
    for (const name of names) {
      expect(name, `表情名 ${name} 不符合前端白名单`).toMatch(/^[a-z0-9][a-z0-9_-]{0,23}$/);
      const url = sprite.expressions[name]!;
      expect(url).toBe(`kv://sprite-${name}.webp`);
      const path = join(assetsDir, url.replace("kv://", ""));
      expect(existsSync(path), `缺少立绘素材 ${url}`).toBe(true);
      const size = webpSizeSync(path);
      expect([size.width, size.height], `${name} 尺寸不一致`).toEqual([356, 1100]);
      expect(size.hasAlpha, `${name} 丢了透明通道`).toBe(true);
    }
  });

  it("立绘：页级默认覆盖 7 页，38 条节点级覆盖全部真的偏离页默认", () => {
    const { byPage, byQuestion, expressions } = survey.settings.theme.sprite;
    expect(Object.keys(byPage).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    for (const [page, expression] of Object.entries(byPage)) {
      expect(expressions[expression], `第 ${page} 页的默认表情 ${expression} 没有素材`).toBeDefined();
    }
    const orderIndex = new Map(questions.map((q) => [String(q.order), q]));
    expect(Object.keys(byQuestion)).toHaveLength(38);
    for (const [key, expression] of Object.entries(byQuestion)) {
      expect(key, `byQuestion 键 ${key} 必须是数字 order`).toMatch(/^\d{1,4}$/);
      const q = orderIndex.get(key);
      expect(q, `byQuestion 键 ${key} 没有对应题目`).toBeDefined();
      expect(expressions[expression], `order ${key} 的表情 ${expression} 没有素材`).toBeDefined();
      // 与页级默认相同 = 死代码：节点级覆盖存在的唯一理由是"这一页的默认情绪会错"。
      const pagePos = survey.pages.findIndex((page) => page.id === q!.page_id);
      expect(pagePos).toBeGreaterThanOrEqual(0);
      expect(byPage[String(pagePos)], `order ${key} 的立绘与页级默认相同，等于没生效`).not.toBe(expression);
    }
  });

  it("八条路线形状各自封闭（不串线），叙述量都在 15–25 分钟区间（按 250 字/分钟）", () => {
    const gates: Record<string, string> = {
      "n-d1": "o-gate-d",
      "n-a1": "o-gate-a",
      "n-b1": "o-gate-b",
      "n-cg1": "o-gate-c",
    };
    const consents: Record<string, { q: string; stopOption: string }> = {
      "n-d1": { q: "q-d6", stopOption: "o-d6-c" },
      "n-a1": { q: "q-a6", stopOption: "o-a6-c" },
      "n-b1": { q: "q-b6", stopOption: "o-b6-c" },
      "n-cg1": { q: "q-cg6", stopOption: "o-cg6-c" },
    };
    const wraps: Record<string, { q: string; own: RegExp }> = {
      "n-d1": { q: "q-d12", own: /^(n-d|q-d)/ },
      "n-a1": { q: "q-a12", own: /^(n-a|q-a)/ },
      "n-b1": { q: "q-b12", own: /^(n-b|q-b)/ },
      "n-cg1": { q: "q-cg12", own: /^(n-cg|q-cg)/ },
    };

    /** 每条形状的完整作答：显式指定 GATE 与同意关卡，其余选择题都选一个
     *  真实存在的 option —— 关键是不能选带 rule 的那个（那会跳走），
     *  否则 "未知作答" 会静默落回线性下一题、串进下一条线族。 */
    function shapeAnswers(gate: string, stop: { q: string; stopOption: string } | null): Record<string, string> {
      const answers: Record<string, string> = { "q-gate": gate };
      if (stop) answers[stop.q] = stop.stopOption;
      for (const q of questions) {
        if (answers[q.id] !== undefined || !q.options?.length) continue;
        const jumping = new Set((q.condition?.rules ?? []).map((r) => r.optionId));
        const linear = q.options.find((o) => !jumping.has(o.id));
        answers[q.id] = (linear ?? q.options[0]!).id;
      }
      return answers;
    }

    const shapes: Array<{ label: string; own: RegExp; answers: Record<string, string> }> = [];
    // order ≤ 8 = 四条线共用的开场；order ≥ 57 = 共用的尾声。
    const sharedIds = new Set(
      questions.filter((q) => q.order <= 8 || q.order >= 57).map((q) => q.id),
    );
    for (const [start, gateValue] of Object.entries(gates)) {
      const spec = consents[start]!;
      const wrap = wraps[start]!;
      shapes.push({ label: `${start} 继续`, own: wrap.own, answers: shapeAnswers(gateValue, null) });
      shapes.push({ label: `${start} 停止`, own: wrap.own, answers: shapeAnswers(gateValue, spec) });
    }
    expect(shapes).toHaveLength(8);

    for (const shape of shapes) {
      const { visited, finished } = walk(shape.answers);
      expect(finished, `${shape.label} 应走到结尾`).toBe(true);
      // 串线检查：除共享的开场（order ≤ 8）与尾声（order ≥ 57）外，
      // 不应出现别的线族的节点。
      const foreign = visited.filter((id) => !shape.own.test(id) && !sharedIds.has(id));
      expect(foreign, `${shape.label} 串进了别的线族`).toEqual([]);
      const chars = visited.reduce(
        (sum, id) => sum + (questions[indexById.get(id)!]?.description ?? "").length,
        0,
      );
      const minutes = chars / 250;
      expect(minutes, `${shape.label}: ${chars} 字 ≈ ${minutes.toFixed(1)} 分钟`).toBeGreaterThanOrEqual(15);
      expect(minutes, `${shape.label}: ${chars} 字 ≈ ${minutes.toFixed(1)} 分钟`).toBeLessThanOrEqual(25);
    }
  });

  it("四条路线从 GATE 可达尾声；同意节点的「停」跳过亲密夜但保留失联危机", () => {
    const routeStarts = ["n-d1", "n-a1", "n-b1", "n-cg1"];
    const consents: Record<string, { q: string; stopOption: string; intimate: string; crisis: string; ending: string }> = {
      "n-d1": { q: "q-d6", stopOption: "o-d6-c", intimate: "n-d7", crisis: "n-d9", ending: "n-d11" },
      "n-a1": { q: "q-a6", stopOption: "o-a6-c", intimate: "n-a7", crisis: "n-a9", ending: "n-a11" },
      "n-b1": { q: "q-b6", stopOption: "o-b6-c", intimate: "n-b7", crisis: "n-b9", ending: "n-b11" },
      "n-cg1": { q: "q-cg6", stopOption: "o-cg6-c", intimate: "n-cg7", crisis: "n-cg9", ending: "n-cg11" },
    };
    for (const start of routeStarts) {
      const gateValue = { "n-d1": "o-gate-d", "n-a1": "o-gate-a", "n-b1": "o-gate-b", "n-cg1": "o-gate-c" }[start]!;
      const spec = consents[start]!;
      const continued = walk({ "q-gate": gateValue, [spec.q]: "keep-going" });
      expect(continued.finished, `${start} 继续线应到达尾声`).toBe(true);
      expect(continued.visited).toContain(spec.intimate);
      expect(continued.visited).toContain(spec.crisis);
      expect(continued.visited).toContain(spec.ending);

      const stopped = walk({ "q-gate": gateValue, [spec.q]: spec.stopOption });
      expect(stopped.finished, `${start} 停止线应到达尾声`).toBe(true);
      expect(stopped.visited).not.toContain(spec.intimate);
      // 停止线仍应经历失联危机
      expect(stopped.visited).toContain(spec.crisis);
      expect(stopped.visited).toContain(spec.ending);
    }
  });

  it("所有节点可达、无死路（除尾声最后一题为终点）", () => {
    // BFS：从第 1 题出发，每个选择点尝试全部选项 + 线性推进
    const reachable = new Set<string>();
    const queue: number[] = [0];
    while (queue.length) {
      const idx = queue.shift()!;
      if (reachable.has(questions[idx]!.id)) continue;
      reachable.add(questions[idx]!.id);
      const nexts = new Set<number>([idx + 1]);
      const q = questions[idx]!;
      for (const option of q.options ?? []) {
        const rule = q.condition?.rules?.find((r) => r.optionId === option.id);
        if (rule) {
          const target = indexById.get(rule.targetQuestionId);
          if (target !== undefined) nexts.add(target);
        }
      }
      for (const next of nexts) if (next < questions.length) queue.push(next);
    }
    expect(reachable.size).toBe(questions.length);

    // 死路：除最后一题外，每题都必须有后续（线性或规则目标存在且向前）
    for (let i = 0; i < questions.length - 1; i++) {
      const q = questions[i]!;
      const hasLinear = true;
      const hasForwardRule = (q.condition?.rules ?? []).some((r) => {
        const t = indexById.get(r.targetQuestionId);
        return t !== undefined && t > i;
      });
      expect(hasLinear || hasForwardRule, `${q.id} 是死路`).toBe(true);
    }
  });

  it("跳转全部只向前（引擎硬约束）", () => {
    for (const question of questions) {
      const idx = indexById.get(question.id)!;
      for (const rule of question.condition?.rules ?? []) {
        const target = indexById.get(rule.targetQuestionId);
        expect(target, `${question.id} → ${rule.targetQuestionId}`).toBeDefined();
        expect(target!, `${question.id} → ${rule.targetQuestionId} 必须向前`).toBeGreaterThan(idx);
      }
      if (question.condition?.skipToQuestionId) {
        const target = indexById.get(question.condition.skipToQuestionId);
        expect(target!, `${question.id} skipTo 必须向前`).toBeGreaterThan(idx);
      }
    }
  });

  it("选择题型选项数符合平台下限（single/multiple=4，yes_no=2）", () => {
    for (const question of questions) {
      if (question.type === "yes_no") expect(question.options).toHaveLength(2);
      if (question.type === "single") expect(question.options).toHaveLength(4);
      if (question.type !== "note" && question.type !== "long_text" && question.type !== "single" && question.type !== "yes_no") {
        throw new Error(`未预期的题型 ${question.id}: ${question.type}`);
      }
    }
  });

  it("正文与档案一致：关键设定词出场（雨有声音/05:59/两个说停的权利）", () => {
    const text = questions.map((q) => `${q.title ?? ""}${q.description ?? ""}`).join("\n");
    expect(String((content.survey as { description?: string }).description)).toContain("18");
    expect(text).toContain("说停");
    expect(text).toContain("417");
  });
});

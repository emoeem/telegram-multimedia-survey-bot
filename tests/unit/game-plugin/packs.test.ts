import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import "../../../src/game-plugin/server-plugins"; // 副作用注册：registry 需要见到 quest
import { parseQuestContent, type QuestContent } from "../../../src/game-plugin/plugins/quest/content";
import { questEngine, type QuestState } from "../../../src/game-plugin/plugins/quest/engine";
import { parseQuestPackBundle } from "../../../src/http/admin/pack-import";

/**
 * 手写示例扩展包的回归护栏（2026-10-30）。
 *
 * 示例包是格式规范的"活文档"，也是新作者抄的模板——它们一旦悄悄变得
 * 不合法，伤害的是整个扩展包生态。这里把 packs 下每个 quest-example-*
 * 示例目录走一遍真实导入管线（ZIP 解析 → manifest/内容校验 → asset 引用清单），
 * 再用引擎剧本化通关，钉住两个规范假设：
 *   1. 多结局分支道具：requireItem 可以锁出一条隐藏结局分支（午夜站台）；
 *   2. 跨场景钥匙：钥匙在 A 场景取得、在 B 场景使用，依赖节点回溯
 *      （回路重入不计分），且 collectible 也能当 requireItem 用（旧宅寻猫）。
 */

const PACKS_ROOT = new URL("../../../packs", import.meta.url).pathname;

const exampleDirs = readdirSync(PACKS_ROOT).filter((name) => {
  if (!name.startsWith("quest-example-")) return false;
  return statSync(join(PACKS_ROOT, name)).isDirectory();
});

/** 目录 → 内存 ZIP（与真实导入管线同构：manifest + quest.json + assets）。 */
function bundleOf(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(readFileSync(join(PACKS_ROOT, dir, "manifest.json"), "utf8")),
    "quest.json": strToU8(readFileSync(join(PACKS_ROOT, dir, "quest.json"), "utf8")),
  };
  const assets = join(PACKS_ROOT, dir, "assets");
  // assets 目录整体可选（规范行为）：lost-study 就是一个无图纯文本包。
  if (statSync(join(PACKS_ROOT, dir, "assets"), { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of readdirSync(assets)) {
      files[`assets/${name}`] = new Uint8Array(readFileSync(join(assets, name)));
    }
  }
  return zipSync(files);
}

function contentOf(dir: string): QuestContent {
  const { content, issues } = parseQuestContent(JSON.parse(readFileSync(join(PACKS_ROOT, dir, "quest.json"), "utf8")));
  expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(content).not.toBeNull();
  return content!;
}

/** 引擎 view 的结构化投影（引擎以 GameEngine<unknown, unknown> 注册，测试里收口一次）。 */
interface QuestViewLike {
  status: string;
  score: number;
  payload: {
    choices: Array<{ locked: boolean; lockHint: string | null }>;
    inventory: Array<{ id: string }>;
    endingTitle: string | null;
    endingNote: string | null;
    cluesFound: number;
    collectiblesFound: number;
    totalItems: number;
  };
}

/** 引擎剧本：按 (节点 id, 选项下标) 序列推进，返回最终 view 与 state。 */
function playthrough(content: QuestContent, script: Array<[string, number]>) {
  const config = { content: JSON.stringify(content), packId: "packs-test", adult: false, cover: null };
  const random = () => 0.5;
  let state: QuestState | null = null;
  let view: QuestViewLike | null = null;
  const created = questEngine.createRun({
    config: config as unknown as Record<string, unknown>,
    persona: "female",
    mode: "normal",
    random,
  });
  state = created.state as QuestState;
  view = created.view as unknown as QuestViewLike;
  for (const [nodeId, choiceIndex] of script) {
    expect(state!.nodeId, `在节点 ${nodeId} 选择第 ${choiceIndex} 项，实际停在 ${state!.nodeId}`).toBe(nodeId);
    const applied = questEngine.apply({
      state,
      config: config as unknown as Record<string, unknown>,
      action: { kind: "choose", choiceIndex, step: state!.steps },
      random,
    });
    state = applied.state as QuestState;
    view = applied.view as unknown as QuestViewLike;
  }
  return { state: state!, view: view! };
}

describe("示例扩展包 · 导入管线", () => {
  it("packs/ 下每个 quest-example-* 都能整包解析", () => {
    expect(exampleDirs.length).toBeGreaterThanOrEqual(3); // lost-study + 本轮两个
    for (const dir of exampleDirs) {
      const bundle = parseQuestPackBundle(bundleOf(dir));
      expect(bundle.manifest.formatVersion, dir).toBe(1);
      expect(bundle.manifest.id, dir).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}$/);
      expect(bundle.content.nodes.length, dir).toBeGreaterThan(0);
      // content 里引用的 asset 都真实存在于包里
      for (const node of bundle.content.nodes) {
        if (node.image?.startsWith("asset:")) {
          expect(bundle.assetNames, `${dir} 的 ${node.image}`).toContain(node.image.slice("asset:".length));
        }
      }
    }
  });

  it("每个包的全部结局都在选项图上可达（忽略门控的图可达性）", () => {
    for (const dir of exampleDirs) {
      const content = contentOf(dir);
      const byId = new Map(content.nodes.map((node) => [node.id, node]));
      const seen = new Set([content.start]);
      const queue = [content.start];
      while (queue.length > 0) {
        const node = byId.get(queue.shift()!);
        for (const choice of node?.choices ?? []) {
          if (!seen.has(choice.goto)) {
            seen.add(choice.goto);
            queue.push(choice.goto);
          }
        }
      }
      const endings = content.nodes.filter((node) => (node.choices ?? []).length === 0);
      expect(endings.length, `${dir} 的结局数`).toBeGreaterThanOrEqual(3);
      for (const ending of endings) {
        expect(seen.has(ending.id), `${dir} 的结局 ${ending.id} 不可达`).toBe(true);
      }
    }
  });
});

describe("示例扩展包 · 规范假设（引擎剧本）", () => {
  it("午夜站台：名牌解锁隐藏真结局，回路重入不重复计分", () => {
    const content = contentOf("quest-example-midnight-station");

    // 没拿名牌时，「递还名牌」是锁定的，且锁定提示指向道具名。
    const early = playthrough(content, [
      ["wake", 0], // bench
      ["bench", 0], // gate（拿了硬币）
    ]);
    const lockedChoice = early.view.payload.choices[1];
    expect(lockedChoice?.locked).toBe(true);
    expect(lockedChoice?.lockHint).toBe("检票员名牌");

    // 拿齐 clue/key/collectible 后走完整分支，抵达真结局。
    const finished = playthrough(content, [
      ["wake", 0], // bench
      ["bench", 0], // gate
      ["gate", 0], // gate-stub（存根 clue）
      ["gate-stub", 0], // corridor
      ["corridor", 0], // office
      ["office", 0], // office-desk（名牌 key）
      ["office-desk", 0], // corridor
      ["corridor", 1], // vending
      ["vending", 0], // vending-out（贴纸 collectible）
      ["vending-out", 0], // gate
      // 回路重入：再走一遍已结算的选择，不得重复计分
      ["gate", 0], // gate-stub（重复）
      ["gate-stub", 1], // end-train 之前先验证分数
    ]);
    const scoreBeforeRepeat = finished.state.score;
    expect(finished.view.payload.endingTitle).toBe("末班车");
    const inventory = finished.view.payload.inventory.map((item) => item.id);
    expect(inventory).toEqual(expect.arrayContaining(["ticket-stub", "name-plate", "coin-old", "route-sticker"]));

    const trueEnding = playthrough(content, [
      ["wake", 0],
      ["bench", 0],
      ["gate", 0],
      ["gate-stub", 0],
      ["corridor", 0],
      ["office", 0],
      ["office-desk", 0],
      ["corridor", 1],
      ["vending", 0],
      ["vending-out", 0],
      ["gate", 1], // 递还名牌（已持有）
      ["confront", 0],
    ]);
    expect(trueEnding.view.payload.endingTitle).toBe("站台尽头的灯");
    expect(trueEnding.view.status).toBe("won");
    // 重复经过的选择不计分：回路重入后的分数只等于各选择首次之和。
    expect(scoreBeforeRepeat).toBe(trueEnding.state.score - 5 - 5); // 减去 confront 两次选择的分值
  });

  it("旧宅寻猫：钥匙跨场景取用，collectible 也能当门控道具", () => {
    const content = contentOf("quest-example-old-house-cat");

    // 没有钥匙：玄关的阁楼门锁定。
    const atStart = playthrough(content, []);
    const atticIndex = atStart.view.payload.choices.findIndex((choice) => choice.lockHint === "阁楼钥匙");
    expect(atticIndex).toBeGreaterThan(-1);
    expect(atStart.view.payload.choices[atticIndex]?.locked).toBe(true);

    // 剧本：客厅拿项圈(clue) → 回玄关 → 后院 → 井房拿钥匙(key) → 原路回玄关
    // → 厨房拿小鱼干(collectible) → 回玄关 → 开阁楼 → 用小鱼干引猫。
    const finished = playthrough(content, [
      ["genkan", 0], // living
      ["living", 0], // living-note（项圈）
      ["living-note", 0], // genkan
      ["genkan", 2], // yard
      ["yard", 0], // well
      ["well", 0], // well-note（钥匙）
      ["well-note", 0], // genkan（跨场景回溯）
      ["genkan", 2], // yard（重入）
      ["yard", 1], // kitchen
      ["kitchen", 0], // kitchen-note（小鱼干）
      ["kitchen-note", 0], // yard
      ["yard", 2], // genkan（重入）
      ["genkan", 3], // attic（钥匙解锁）
      ["attic", 0], // end-found（小鱼干门控）
    ]);
    expect(finished.view.payload.endingTitle).toBe("鱼干外交");
    expect(finished.view.status).toBe("won");
    const inventory = finished.view.payload.inventory.map((item) => item.id);
    expect(inventory).toEqual(expect.arrayContaining(["cat-collar", "attic-key", "fish-snack"]));

    // 有钥匙但没拿小鱼干：阁楼能进，「用小鱼干引下来」锁定，只能走另一个结局。
    const noFish = playthrough(content, [
      ["genkan", 2], // yard
      ["yard", 0], // well
      ["well", 0], // well-note（钥匙）
      ["well-note", 0], // genkan
      ["genkan", 3], // attic
    ]);
    const atticChoices = noFish.view.payload.choices;
    expect(atticChoices[0]?.locked).toBe(true);
    expect(atticChoices[0]?.lockHint).toBe("小鱼干");
    expect(atticChoices[1]?.locked).toBe(false);
  });
});

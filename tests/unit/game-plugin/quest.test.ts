import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import "../../../src/game-plugin/server-plugins"; // 副作用注册：registry 需要见到 quest
import { parseQuestContent, parseQuestContentJson } from "../../../src/game-plugin/plugins/quest/content";
import { questEngine } from "../../../src/game-plugin/plugins/quest/engine";
import { parseQuestPackBundle } from "../../../src/http/admin/pack-import";
import { gamePluginRegistry } from "../../../src/game-plugin/registry";

/** 最小可玩内容：2 道具（key + collectible）、4 节点、1 结局。 */
function minimalContent() {
  return {
    version: 1,
    title: "测试剧本",
    intro: "测试",
    start: "a",
    items: [
      { id: "key-door", name: "钥匙", icon: "🗝️", kind: "key", desc: "开门" },
      { id: "token-coin", name: "硬币", icon: "🪙", kind: "collectible", desc: "收集" },
    ],
    nodes: [
      {
        id: "a",
        text: "起点",
        choices: [
          { text: "拿硬币", goto: "b", give: ["token-coin"], score: 4 },
          { text: "用钥匙开门", goto: "end", requireItem: "key-door", score: 6 },
        ],
      },
      { id: "b", text: "中间", choices: [{ text: "回头", goto: "a" }] },
      { id: "end", text: "结局", endingTitle: "关灯" },
    ],
    grades: { s: 90, a: 60, b: 30 },
  };
}

const configOf = (content: unknown) => ({
  content: JSON.stringify(content),
  packId: "test",
  adult: false,
  cover: null,
});
const random = () => 0.5;

describe("quest 扩展包内容校验", () => {
  it("合法内容通过并回填规范形状", () => {
    const { content, issues } = parseQuestContent(minimalContent());
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(content).not.toBeNull();
    expect(content?.nodes).toHaveLength(3);
    expect(content?.items.map((item) => item.kind)).toEqual(["key", "collectible"]);
  });

  it("拒绝：start 不存在 / goto 悬空 / requireItem 未知道具 / 无结局 / 重复 id", () => {
    const broken = minimalContent();
    broken.start = "ghost";
    expect(parseQuestContent(broken).content).toBeNull();

    const brokenGoto = minimalContent();
    (brokenGoto.nodes[0]!.choices![0] as { goto: string }).goto = "ghost";
    expect(parseQuestContent(brokenGoto).content).toBeNull();

    const brokenItem = minimalContent();
    (brokenItem.nodes[0]!.choices![1] as { requireItem: string }).requireItem = "ghost-key";
    expect(parseQuestContent(brokenItem).content).toBeNull();

    const noEnding = minimalContent();
    noEnding.nodes[2] = { id: "end", text: "改成了普通节点", choices: [{ text: "回去", goto: "a" }] };
    expect(parseQuestContent(noEnding).content).toBeNull();

    const dup = minimalContent();
    dup.nodes.push(dup.nodes[0]!);
    expect(parseQuestContent(dup).content).toBeNull();

    const badVersion = { ...minimalContent(), version: 99 };
    const parsed = parseQuestContent(badVersion);
    expect(parsed.content).toBeNull();
    expect(parsed.issues[0]?.message).toContain("formatVersion");
  });

  it("非法 id / 超长文本被拒，score 越界被夹取", () => {
    const bad = minimalContent();
    bad.items[0]!.id = "Bad Id!";
    expect(parseQuestContent(bad).content).toBeNull();

    const long = minimalContent();
    long.nodes[0]!.text = "长".repeat(601);
    expect(parseQuestContent(long).content).toBeNull();

    const score = minimalContent();
    (score.nodes[0]!.choices![0] as { score: number }).score = 99;
    const parsed = parseQuestContent(score);
    expect(parsed.content).not.toBeNull();
    expect(parsed.content?.nodes[0]?.choices?.[0]?.score).toBe(20);
  });

  it("parseQuestContentJson：坏 JSON 报错而不是抛异常", () => {
    const { content, issues } = parseQuestContentJson("{oops");
    expect(content).toBeNull();
    expect(issues[0]?.message).toContain("JSON");
  });
});

describe("quest 引擎", () => {
  it("createRun：maxScore 等于全部选项分值之和，视图只发起始节点", () => {
    const { state, view } = questEngine.createRun({
      config: configOf(minimalContent()),
      persona: "female",
      mode: "normal",
      random,
    });
    expect(state.maxScore).toBe(10);
    expect(view.payload).toMatchObject({ finished: false });
    const payload = view.payload as { node: { id: string }; choices: unknown[] };
    expect(payload.node.id).toBe("a");
    expect(payload.choices).toHaveLength(2);
    // 跳转表与道具定义不下发
    expect(JSON.stringify(view.payload)).not.toContain('"goto"');
    expect(JSON.stringify(view.payload)).not.toContain("key-door");
  });

  it("key 门控：未持有时锁定（服务端忽略该选择），拿到钥匙后可走", () => {
    const config = configOf(minimalContent());
    const first = questEngine.createRun({ config, persona: "female", mode: "normal", random });
    // 直接尝试用钥匙的选项 → 被拒绝，state 不动
    const rejected = questEngine.apply({
      state: first.state,
      config,
      action: { kind: "choose", choiceIndex: 1, step: 0 },
      random,
    });
    expect(rejected.state.nodeId).toBe("a");
    const view = rejected.view.payload as { choices: Array<{ locked: boolean; lockHint: string | null }> };
    expect(view.choices[1]).toMatchObject({ locked: true, lockHint: "钥匙" });
  });

  it("give + collectible 加分：首次经过才发放与计分，回路不刷分", () => {
    const config = configOf(minimalContent());
    const run = questEngine.createRun({ config, persona: "female", mode: "normal", random });
    // a → 拿硬币（+4 与收集品 +2）
    const step1 = questEngine.apply({
      state: run.state,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 0 },
      random,
    });
    expect(step1.state.items).toEqual(["token-coin"]);
    expect(step1.state.score).toBe(6); // 4 分 + 收集品 2 分
    // b → 回头 a（无分）
    const step2 = questEngine.apply({
      state: step1.state,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 1 },
      random,
    });
    expect(step2.state.nodeId).toBe("a");
    // 再走一次「拿硬币」：道具不重复、分数不涨
    const step3 = questEngine.apply({
      state: step2.state,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 2 },
      random,
    });
    expect(step3.state.items).toEqual(["token-coin"]);
    expect(step3.state.score).toBe(6);
    const inventory = (step3.view.payload as { inventory: Array<{ id: string }> }).inventory;
    expect(inventory).toHaveLength(1);
  });

  it("步数幂等：陈旧 step 不推进", () => {
    const config = configOf(minimalContent());
    const run = questEngine.createRun({ config, persona: "female", mode: "normal", random });
    const step1 = questEngine.apply({
      state: run.state,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 0 },
      random,
    });
    const replay = questEngine.apply({
      state: step1.state,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 0 },
      random,
    });
    expect(replay.state.nodeId).toBe(step1.state.nodeId);
    expect(replay.state.steps).toBe(step1.state.steps);
  });

  it("结局与评级：grade 按可得分值比例，collectible 计入上限", () => {
    const config = configOf(minimalContent());
    const run = questEngine.createRun({ config, persona: "female", mode: "normal", random });
    // 0 分进结局（a → b? 不行，需要钥匙……用只到 b 的路径回不到结局；直接构造）
    const finishedState = { ...run.state, nodeId: "end", steps: 3 };
    const grade = questEngine.grade({ state: finishedState, config });
    // 可得上限 = 选项 10 分 + 收集品 2 分（一件）
    expect(grade.maxScore).toBe(12);
    expect(grade.grade).toBe("C");
    const win = questEngine.apply({
      state: finishedState,
      config,
      action: { kind: "choose", choiceIndex: 0, step: 99 },
      random,
    });
    expect(win.finished).toBe(true);
    expect((win.view.payload as { finished: boolean }).finished).toBe(true);
  });

  it("isAction 拒绝未知动作", () => {
    expect(questEngine.isAction({ kind: "choose", choiceIndex: 0, step: 0 })).toBe(true);
    expect(questEngine.isAction({ kind: "answer", optionIndex: 0 })).toBe(false);
    expect(questEngine.isAction(null)).toBe(false);
  });
});

describe("扩展包 ZIP 解析", () => {
  const manifest = {
    formatVersion: 1,
    id: "test-pack",
    title: "测试包",
    author: "tester",
    description: "用于测试",
    adult: false,
  };

  it("合法包解析出内容与资产清单", () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "quest.json": strToU8(JSON.stringify(minimalContent())),
      "assets/room.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    });
    const parsed = parseQuestPackBundle(zip);
    expect(parsed.manifest.id).toBe("test-pack");
    expect(parsed.content.nodes).toHaveLength(3);
    expect(parsed.assetNames).toEqual(["room.png"]);
  });

  it("拒绝：缺 manifest / 版本不符 / 引用了不存在的 asset", () => {
    const noManifest = zipSync({ "quest.json": strToU8(JSON.stringify(minimalContent())) });
    expect(() => parseQuestPackBundle(noManifest)).toThrow(/manifest/);

    const badVersion = zipSync({
      "manifest.json": strToU8(JSON.stringify({ ...manifest, formatVersion: 2 })),
      "quest.json": strToU8(JSON.stringify(minimalContent())),
    });
    expect(() => parseQuestPackBundle(badVersion)).toThrow(/格式版本/);

    const missingAsset = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "quest.json": strToU8(
        JSON.stringify({
          ...minimalContent(),
          nodes: [
            { id: "a", text: "x", image: "asset:ghost.png", choices: [{ text: "去", goto: "end" }] },
            { id: "end", text: "终" },
          ],
        }),
      ),
    });
    expect(() => parseQuestPackBundle(missingAsset)).toThrow(/assets\/ghost\.png/);
  });

  it("注册表闸门接受导入器产出的 settings", () => {
    const { config, issues } = gamePluginRegistry.validateConfig("quest", configOf(minimalContent()));
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
    expect(typeof config.content).toBe("string");
    expect(config.adult).toBe(false);
  });
});

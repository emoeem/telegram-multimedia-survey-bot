import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildCanvasEdges } from "../../../admin/src/editor/canvas-edges";
import { layoutGraph } from "../../../admin/src/editor/node-graph/layout";
import { surveyToGraph, type GraphQuestionInput } from "../../../admin/src/editor/node-graph/to-graph";

/**
 * A4 批2：统一节点编辑器转换器的保真测试。
 *
 * 「round-trip 无损」在本架构下的精确含义：画布是视图、问卷 JSON 是唯一
 * 存储，因此无损 = **graph 完整保真地表示 survey**——
 *  1. 每道题恰好一个节点（id 一一对应，顺序一致）；
 *  2. 线性链边 = 相邻题目按 order 连接，entry/ending 首尾各一；
 *  3. 条件边集合与 buildCanvasEdges（LogicLayer 同源）完全一致；
 *  4. 布局不丢节点、不产生重叠坐标。
 * 写方向（图操作→问卷命令）走既有 editor actions，不经过新序列化器，
 * 因此不存在「图→JSON 转换损耗」这一类风险面。
 */

function q(partial: Partial<GraphQuestionInput> & { id: number; order: number }): GraphQuestionInput {
  return {
    type: "text",
    title: `题 ${partial.id}`,
    required: false,
    pageId: null,
    condition: null,
    options: [],
    speaker: null,
    gamePackId: null,
    ...partial,
  };
}

describe("surveyToGraph 保真", () => {
  it("线性问卷：每题一节点，链边连接相邻题，entry/ending 首尾", () => {
    const questions = [q({ id: 1, order: 0 }), q({ id: 2, order: 1 }), q({ id: 3, order: 2 })];
    const graph = surveyToGraph({ questions, pages: [] });

    const questionNodes = graph.nodes.filter((node) => node.data.kind === "question");
    expect(questionNodes.map((node) => node.data.questionId)).toEqual([1, 2, 3]);

    const sequenceTargets = graph.edges
      .filter((edge) => edge.data?.kind === "sequence")
      .map((edge) => [edge.source, edge.target]);
    expect(sequenceTargets).toEqual([
      ["entry", "q1"],
      ["q1", "q2"],
      ["q2", "q3"],
      ["q3", "ending"],
    ]);
    expect(graph.edges.filter((edge) => edge.data?.kind !== "sequence")).toHaveLength(0);
  });

  it("条件分支：边集合与 buildCanvasEdges 同源一致，节点带 branching 角标", () => {
    const questions = [
      q({ id: 1, order: 0, type: "single", options: [{ id: 11 }, { id: 12 }], condition: { rules: [{ optionId: 11, targetQuestionId: 3 }] } }),
      q({ id: 2, order: 1 }),
      q({ id: 3, order: 2 }),
    ];
    const graph = surveyToGraph({ questions, pages: [] });

    const conditionEdges = graph.edges.filter((edge) => edge.data?.kind !== "sequence");
    const expected = buildCanvasEdges(questions);
    expect(conditionEdges).toHaveLength(expected.length);
    expect(conditionEdges.map((edge) => [edge.source, edge.target])).toEqual([
      ["q1", "q3"],
    ]);
    expect(conditionEdges[0]?.data?.label).toBe(expected[0]?.label);

    const branchNode = graph.nodes.find((node) => node.data.questionId === 1);
    expect(branchNode?.data.branching).toBe(true);
    expect(graph.nodes.find((node) => node.data.questionId === 2)?.data.branching).toBe(false);
  });

  it("节点外观：note/scene/game/quest 各有 registry 语义（剧情/场景/道具）", () => {
    const questions = [
      q({ id: 1, order: 0, type: "note", speaker: "苏" }),
      q({ id: 2, order: 1, type: "scene" }),
      q({ id: 3, order: 2, type: "game", gamePackId: 7 }),
    ];
    const graph = surveyToGraph({ questions, pages: [], gamePackNames: { 7: "午夜站台" } });
    expect(graph.nodes.find((n) => n.data.questionId === 1)?.data.meta).toBe("说话人 苏");
    expect(graph.nodes.find((n) => n.data.questionId === 2)?.data.meta).toBe("热点场景");
    expect(graph.nodes.find((n) => n.data.questionId === 3)?.data.meta).toBe("任务包 午夜站台");
  });

  it("多页问卷：分页节点按 order 出现在页分组之间；单页不出分页节点", () => {
    const pages = [
      { id: 1, title: "第一幕", order: 0 },
      { id: 2, title: "第二幕", order: 1 },
    ];
    const questions = [q({ id: 1, order: 0, pageId: 1 }), q({ id: 2, order: 1, pageId: 2 })];
    const multi = surveyToGraph({ questions, pages });
    expect(multi.nodes.filter((node) => node.data.kind === "page")).toHaveLength(2);

    const single = surveyToGraph({ questions: [q({ id: 1, order: 0, pageId: 1 })], pages: [pages[0]!] });
    expect(single.nodes.filter((node) => node.data.kind === "page")).toHaveLength(0);
  });

  it("未知题型走兜底外观，不抛错（注册表漏登记不崩画布）", () => {
    const graph = surveyToGraph({ questions: [q({ id: 1, order: 0, type: "mystery" })], pages: [] });
    expect(graph.nodes).toHaveLength(3); // entry + question + ending
    expect(graph.nodes[1]?.data.title).toContain("题 1");
  });
});

describe("layoutGraph", () => {
  it("linear：单列纵向流，顺序 = entry→题目（order）→ending", () => {
    const graph = surveyToGraph({ questions: [q({ id: 5, order: 0 }), q({ id: 3, order: 1 })], pages: [] });
    const laid = layoutGraph(graph, "linear");
    const ys = laid.map((node) => node.position.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(laid[0]?.id).toBe("entry");
    expect(laid.at(-1)?.id).toBe("ending");
    // 题目顺序按 order 而不是 id：id=5 在前。
    expect(laid[1]?.data.questionId).toBe(5);
  });

  it("layered：分支目标在更深层（最长路径），同层不重叠", () => {
    const questions = [
      q({ id: 1, order: 0, type: "single", options: [{ id: 11 }], condition: { rules: [{ optionId: 11, targetQuestionId: 4 }] } }),
      q({ id: 2, order: 1 }),
      q({ id: 3, order: 2 }),
      q({ id: 4, order: 3 }),
    ];
    const graph = surveyToGraph({ questions, pages: [] });
    const laid = layoutGraph(graph, "layered");
    const byId = new Map(laid.map((node) => [node.id, node]));
    const depthOf = (id: string) => byId.get(id)?.position.y ?? -1;
    // q4 同时是 q3 的顺序后继和 q1 的分支目标：深度取最长路径。
    expect(depthOf("q4")).toBeGreaterThan(depthOf("q3"));
    // 同层节点 y 相同、x 不同（不重叠；排除参照节点自身）。
    const sameLayer = laid.filter((node) => node.position.y === depthOf("q2") && node.id !== "q2");
    for (const node of sameLayer) {
      expect(node.position.x).not.toBe(byId.get("q2")?.position.x);
    }
  });

  it("环（手改 JSON）不挂死：Kahn 不收敛时回退线性布局", () => {
    const questions = [
      q({ id: 1, order: 0, condition: { rules: [{ optionId: 1, targetQuestionId: 1 }] } }),
    ];
    const graph = surveyToGraph({ questions, pages: [] });
    expect(() => layoutGraph(graph, "layered")).not.toThrow();
  });
});

describe("真实内容回放（仓库三份存量）", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

  function loadRealQuestions(path: string): GraphQuestionInput[] {
    const raw = JSON.parse(readFileSync(`${repoRoot}${path}`, "utf8")) as {
      survey?: { questions?: unknown[] };
      questions?: unknown[];
    };
    const list = (raw.survey?.questions ?? raw.questions ?? []) as Array<Record<string, unknown>>;
    return list.map((item, index) => ({
      // 编辑器运行时题目 id 恒为数字；导入快照里的字符串 id（"q_1"）按序号映射。
      id: Number(item.id) || index + 1,
      order: Number(item.order ?? index + 1),
      type: String(item.type ?? "text"),
      title: String(item.title ?? ""),
      required: Boolean(item.required),
      pageId: (item.pageId as number | null) ?? null,
      condition: (item.condition as Record<string, unknown> | null) ?? null,
      options: Array.isArray(item.options) ? (item.options as Array<{ id: number }>) : [],
      speaker: null,
      gamePackId: null,
    }));
  }

  function assertFaithful(questions: GraphQuestionInput[], label: string) {
    const graph = surveyToGraph({ questions, pages: [] });
    // 每题恰好一个节点。
    const ids = graph.nodes.filter((n) => n.data.kind === "question").map((n) => n.data.questionId);
    expect(new Set(ids).size, `${label}: 节点无重复`).toBe(ids.length);
    expect(ids, `${label}: 题目全覆盖`).toEqual(questions.map((item) => item.id));
    // 线性链 = n+1 条顺序边（含 entry/ending）。
    expect(graph.edges.filter((e) => e.data?.kind === "sequence"), `${label}: 链边数`).toHaveLength(
      questions.length + 1,
    );
    // 条件边与 buildCanvasEdges 完全一致。
    const conditionEdges = graph.edges.filter((e) => e.data?.kind !== "sequence");
    expect(conditionEdges.map((e) => [e.source, e.target, e.data?.label]), `${label}: 条件边一致`).toEqual(
      buildCanvasEdges(questions).map((e) => [`q${e.fromId}`, `q${e.toId}`, e.label]),
    );
    // 两种布局都不丢节点。
    for (const mode of ["linear", "layered"] as const) {
      expect(layoutGraph(graph, mode), `${label}: ${mode} 布局保节点`).toHaveLength(graph.nodes.length);
    }
  }

  it("survey.json：93 题纯线性问卷", () => {
    const questions = loadRealQuestions("survey.json");
    expect(questions.length).toBeGreaterThan(50);
    assertFaithful(questions, "survey.json");
  });

  it("qa/fixtures/galgame-118.json：58 题 galgame 流（9 条条件分支）", () => {
    const questions = loadRealQuestions("qa/fixtures/galgame-118.json");
    expect(questions.length).toBeGreaterThan(30);
    const conditionCount = questions.filter((item) => item.condition).length;
    expect(conditionCount).toBeGreaterThan(3);
    assertFaithful(questions, "galgame-118");
  });

  it("personal-profile-survey.json：28 题含上传题型", () => {
    const questions = loadRealQuestions("personal-profile-survey.json");
    expect(questions.length).toBeGreaterThan(20);
    assertFaithful(questions, "personal-profile");
  });
});

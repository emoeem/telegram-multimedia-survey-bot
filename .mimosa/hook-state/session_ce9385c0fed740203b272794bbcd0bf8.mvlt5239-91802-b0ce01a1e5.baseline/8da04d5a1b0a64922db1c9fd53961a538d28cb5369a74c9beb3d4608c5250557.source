import { describe, expect, it } from "vitest";

import { donutOption } from "../../../admin/src/chart-options";

const SLICES = [
  { name: "草稿", value: 3, color: "#64748b" },
  { name: "已发布", value: 84, color: "#16a34a" },
  { name: "已关闭", value: 1, color: "#f59e0b" },
];

/**
 * 环形图圆心的「总数 + 总计」曾经用 `graphic` 画成两个 text，位置写成
 * `calc(50% - 10px)` / `calc(50% + 14px)`。ECharts 的 graphic 定位不接受 CSS
 * `calc()`，两个字符串都被丢弃，于是所有文字塌到画布左上角：数字、说明、以及
 * 顶部那个扇区标签三层叠在一起糊成一团（375px 下最明显）。
 *
 * 这些断言锁住的是「结构」，不是像素：圆心文案必须由 series 的 center label 提供
 * （ECharts 会把它精确放在 center 上），并且选项里不允许再出现 calc()。
 */
describe("donutOption 圆心文案", () => {
  it("把总数放在 series 的 center label 上，而不是 graphic", () => {
    const option = donutOption(SLICES);
    expect(option).not.toBeNull();
    const series = option!.series as Array<Record<string, unknown>>;

    expect(option).not.toHaveProperty("graphic");
    expect(series).toHaveLength(2);

    const centerLabel = series[1]!.label as Record<string, unknown>;
    expect(centerLabel.position).toBe("center");
    expect(series[1]!.silent).toBe(true);
    expect(centerLabel.formatter).toBe("{total|88}\n{caption|总计}");
  });

  it("圆心文案跟扇区圆心同一个坐标", () => {
    const option = donutOption(SLICES, { center: ["35%", "50%"] });
    const [ring, center] = option!.series as Array<Record<string, unknown>>;
    expect(ring!.center).toEqual(["35%", "50%"]);
    expect(center!.center).toEqual(ring!.center);
  });

  it("center 传裸数字按百分比处理（否则会落到画布原点）", () => {
    const option = donutOption(SLICES, { center: [35, 50] });
    const [ring, center] = option!.series as Array<Record<string, unknown>>;
    expect(ring!.center).toEqual(["35%", "50%"]);
    expect(center!.center).toEqual(["35%", "50%"]);
  });

  it("任何位置都不再出现 calc()", () => {
    for (const center of [undefined, ["35%" as const, "50%" as const], [28, 50] as const]) {
      const json = JSON.stringify(donutOption(SLICES, center ? { center: [...center] as [number, number] } : {}));
      expect(json).not.toContain("calc(");
    }
  });

  it("图例只列真实扇区，圆心那个系列不会漏出一行空白", () => {
    const option = donutOption(SLICES);
    const legend = option!.legend as Record<string, unknown>;
    expect(legend.data).toEqual(["草稿", "已发布", "已关闭"]);
  });

  it("总数为 0 的切片既不进扇区也不进图例", () => {
    const option = donutOption([...SLICES, { name: "已归档", value: 0 }]);
    const legend = option!.legend as Record<string, unknown>;
    expect(legend.data).toEqual(["草稿", "已发布", "已关闭"]);
    const centerLabel = (option!.series as Array<Record<string, unknown>>)[1]!.label as Record<string, unknown>;
    expect(centerLabel.formatter).toContain("{total|88}");
  });

  it("没有任何有效切片时返回 null（调用方会渲染空态）", () => {
    expect(donutOption([])).toBeNull();
    expect(donutOption([{ name: "已归档", value: 0 }])).toBeNull();
  });

  it("showLegend: false 时不生成图例，但圆心总数仍在", () => {
    const option = donutOption(SLICES, { showLegend: false });
    expect(option!.legend).toBeUndefined();
    const centerLabel = (option!.series as Array<Record<string, unknown>>)[1]!.label as Record<string, unknown>;
    expect(centerLabel.formatter).toBe("{total|88}\n{caption|总计}");
  });
});

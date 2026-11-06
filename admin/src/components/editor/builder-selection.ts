/**
 * 画布选中态（2026-11-07 自旧壳 StructureTree 迁出为共享类型）：
 * 「设置面板」与「某道题」二选一；新壳物料/画布/属性面板均以此为准。
 */
export type BuilderSelection = { kind: "settings" } | { kind: "question"; id: number };

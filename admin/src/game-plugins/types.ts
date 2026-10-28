import type { ComponentType } from "react";
import type {
  ConfigIssue,
  ConfigOf,
  GameGrade,
  GamePluginManifest,
  GameRunView,
  PropField,
} from "../../../src/game-plugin/types";

/**
 * 客户端插件协议（admin 专用，允许 import react）。
 *
 * 与 src/game-plugin/types.ts 的分工：那边是 manifest / 属性 Schema / 服务端
 * 引擎（Worker 也要编译），这边只是视图与宿主桥。
 */

/** 答案：规范形状，插件不得自己造存储结构。 */
export interface GamePlayResult {
  runId: number;
  score: number;
  grade: GameGrade | string | null;
  completed: boolean;
}

/**
 * 宿主桥：插件只通过这些方法与服务端说话——不自己 fetch、不碰存储。
 * commit 由宿主负责把 runId 写回答卷（服务端再按 runId 重算分数）。
 */
export interface GameHostBridge {
  start(): Promise<GameRunView>;
  act(action: unknown): Promise<{ view: GameRunView; finished: boolean; result: GamePlayResult | null }>;
  /** 宿主记住本局 id 并写回答卷；插件不参与。 */
  commit(): Promise<GamePlayResult | null>;
  /** 18+ 门禁状态；未确认时插件应停留在门禁界面（由宿主渲染）。 */
  adultAck: boolean;
  requestAdultAck(): void;
  /** 玩家主动放弃本局（服务端结算为未通关）。 */
  abandon(): Promise<void>;
}

export interface GamePlayViewProps<P> {
  config: P;
  host: GameHostBridge;
  /** 已保存的答案（回落展示成绩）。 */
  saved: GamePlayResult | null;
  disabled?: boolean;
}

export interface GameEditViewProps<P> {
  config: P;
  onChange(next: P): void;
  /** 基础/专业模式：视图可据此隐藏细节。 */
  mode: "basic" | "pro";
}

/** 生命周期：可选、纯回调；宿主保证调用顺序。 */
export interface GameLifecycleHooks<P> {
  onMount?(ctx: { mode: "edit" | "play"; config: P }): void | (() => void);
  onConfigChange?(next: P, prev: P, ctx: { mode: "edit" }): void;
  onSubmit?(result: GamePlayResult, ctx: { config: P }): void;
}

/**
 * 客户端插件半身。
 *
 * 两个类型参数：P 是属性 Schema，C 是插件自己的配置接口。C 之所以不让它从
 * P 自动推导——列表项的嵌套结构（如卡组里的选项）推导出来只能是
 * Record<string, unknown>[]，插件内部需要它自己的强类型；Schema 负责运行期
 * 归一化，C 负责编译期形状，两者由 validateConfig 的边界断言衔接。
 */
export interface GamePluginClient<P extends readonly PropField[], C = ConfigOf<P>> {
  manifest: GamePluginManifest;
  props: P;
  validate?: (config: C) => readonly ConfigIssue[];
  EditView: ComponentType<GameEditViewProps<C>>;
  PlayView: ComponentType<GamePlayViewProps<C>>;
  hooks?: GameLifecycleHooks<C>;
  /** 结构树/画布上的一行摘要，缺省回落到 manifest.title。 */
  summary?(config: C): string;
}

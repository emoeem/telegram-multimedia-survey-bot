/**
 * 游戏即插件：标准接入协议（服务端半身）。
 *
 * 设计意图：本项目的小游戏得分必须由服务端权威计算（客户端提交的分数一律
 * 丢弃），所以"插件"不是单一 React 组件，而是「一个 id、两半身」：
 *
 *   清单 manifest + 属性 Schema + 服务端引擎   ← 本文件（纯数据/纯函数，Worker 与 admin 共用）
 *   编辑态/答题态 React 组件                   ← admin/src/game-plugins/types.ts
 *
 * 两半用同一个 id 绑定，id 落进 task_packs.game_type。本文件被 Worker 编译，
 * 因此禁止 import react / DOM。
 */

export const GAME_PLUGIN_HOST_API = 1 as const;

export type GameCategory = "challenge" | "quiz" | "random" | "story";

/** 元信息。id 一经发布不可修改（历史 task_runs 靠它路由回引擎）。 */
export interface GamePluginManifest {
  /** kebab-case 稳定标识，同时是 task_packs.game_type 的取值。 */
  id: string;
  /** 英文短名，与目录名一致。 */
  name: string;
  /** 玩家端展示名。 */
  title: string;
  /** lucide 图标名或 emoji。 */
  icon: string;
  /** 一句话描述，物料区卡片用。 */
  description: string;
  category: GameCategory;
  version: string;
  author: string;
  hostApi: typeof GAME_PLUGIN_HOST_API;
  /** 用到的宿主能力；宿主据此决定是否展示身份/模式选择与 18+ 门禁。 */
  capabilities: {
    persona?: boolean;
    modes?: readonly string[];
    adult?: boolean;
  };
}

/* ---------------------------------------------------------------- *
 * 属性 Schema：声明可配置参数，编辑器据此自动生成属性面板。
 * 归一化与校验在 props.ts，纯函数、可单测。
 * ---------------------------------------------------------------- */

interface PropBase {
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  /**
   * 该属性是否参与数据收集/计分：true 的项属于"作答数据"的一部分
   * （导出答卷时会带出）；纯呈现配置（封面图、主题）为 false。
   */
  collects?: boolean;
  /** 基础模式是否展示；缺省 true。专业模式始终展示。 */
  basic?: boolean;
  /** 条件显示：仅在返回 true 时渲染（运行时函数，不进 JSON）。 */
  when?: (config: Record<string, unknown>) => boolean;
}

export interface TextProp extends PropBase {
  kind: "text";
  default: string;
  maxLength?: number;
  placeholder?: string;
}
export interface TextAreaProp extends PropBase {
  kind: "textarea";
  default: string;
  maxLength?: number;
  rows?: number;
}
export interface NumberProp extends PropBase {
  kind: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
}
export interface BooleanProp extends PropBase {
  kind: "boolean";
  default: boolean;
}
export interface SelectProp extends PropBase {
  kind: "select";
  default: string;
  options: readonly { value: string; label: string }[];
}
/** 素材库引用：值是 media_assets.id（0091 素材库，含去重与引用计数）。 */
export interface MediaProp extends PropBase {
  kind: "media";
  default: null;
  accept: "image" | "audio" | "video" | "any";
}
/** 重复项（卡组/奖池）。maxItems 防止配置把单行 D1 撑爆。 */
export interface ListProp extends PropBase {
  kind: "list";
  default: readonly never[];
  maxItems: number;
  itemFields: readonly PropField[];
  itemLabel: (item: Record<string, unknown>, index: number) => string;
}

export type PropField =
  | TextProp
  | TextAreaProp
  | NumberProp
  | BooleanProp
  | SelectProp
  | MediaProp
  | ListProp;

/** 字段 → 值类型，保证 config 端到端类型安全。 */
export type PropValue<F extends PropField> = F extends TextProp | TextAreaProp | SelectProp
  ? string
  : F extends NumberProp
    ? number
    : F extends BooleanProp
      ? boolean
      : F extends MediaProp
        ? number | null
        : F extends ListProp
          ? Array<Record<string, unknown>>
          : never;

export type ConfigOf<P extends readonly PropField[]> = {
  [F in P[number] as F["key"]]: PropValue<F>;
};

/* ---------------------------------------------------------------- *
 * 校验
 * ---------------------------------------------------------------- */

export interface ConfigIssue {
  /** 定位到字段 key；"" 表示整体问题。 */
  key: string;
  message: string;
  /** error 阻塞保存；warning 只在物料卡片标黄。 */
  severity: "error" | "warning";
}

export type ConfigValidator<P> = (config: P) => readonly ConfigIssue[];

/* ---------------------------------------------------------------- *
 * 运行视图与引擎
 * ---------------------------------------------------------------- */

/** 服务端算好、两端直接渲染的一帧。payload 为插件自定的不透明数据。 */
export interface GameRunView {
  status: "active" | "won" | "lost";
  score: number;
  maxScore: number;
  step: number;
  total: number;
  payload: Record<string, unknown>;
}

export type GameGrade = "S" | "A" | "B" | "C";

/**
 * 服务端引擎：纯函数 + 显式状态，无 IO、无 D1。
 * state 会整体序列化进 task_runs.state_json，因此必须可 JSON 往返。
 */
export interface GameEngine<S, A> {
  createRun(input: {
    config: Record<string, unknown>;
    persona: "male" | "female";
    mode: string;
    /** 注入随机源，保证同 seed 可复现（测试与断线重放）。 */
    random: () => number;
  }): { state: S; view: GameRunView };
  apply(input: {
    state: S;
    config: Record<string, unknown>;
    action: A;
    random: () => number;
  }): { state: S; view: GameRunView; finished: boolean };
  grade(input: { state: S; config: Record<string, unknown> }): { grade: GameGrade; maxScore: number };
  /** 断线重连：把 state 还原成视图，不推进任何逻辑。 */
  view(input: { state: S; config: Record<string, unknown> }): GameRunView;
  /** 动作白名单：未知 action 一律 400，避免各插件自行反序列化。 */
  isAction(value: unknown): value is A;
}

/** 服务端插件半身：清单 + 属性声明 + 引擎。 */
export interface GamePluginServer {
  manifest: GamePluginManifest;
  props: readonly PropField[];
  engine: GameEngine<unknown, unknown>;
}

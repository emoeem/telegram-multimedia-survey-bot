import "../game-plugin/server-plugins"; // 副作用导入：确保任何使用方都能看到已注册的插件
import { gamePluginRegistry } from "../game-plugin/registry";

/**
 * 玩法类型清单：内置的爬塔（tower，走历史列结构）+ 全部已注册插件。
 *
 * 爬塔刻意**不**进插件注册表：它的配置在 task_packs 的楼层/任务列里，
 * 不在 settings_json，硬塞进 Schema 会逼出一个只服务历史的空 Schema。
 * 新玩法一律走插件路径，这里只是把两者合并成一份对外的类型清单。
 */

export interface GameTypeDescriptor {
  id: string;
  label: string;
  description: string;
  /** true = 内置玩法（爬塔），false = 插件玩法。 */
  builtin: boolean;
}

const TOWER: GameTypeDescriptor = {
  id: "tower",
  label: "爬塔挑战",
  description: "逐层上行，每层抽取一个任务，按完成度评级。",
  builtin: true,
};

export function listGameTypes(): GameTypeDescriptor[] {
  const plugins = gamePluginRegistry.list().map((manifest) => ({
    id: manifest.id,
    label: manifest.title,
    description: manifest.description,
    builtin: false,
  }));
  return [TOWER, ...plugins];
}

/** 只接受已知玩法（内置或已注册插件）；未知值返回 null。 */
export function normalizeGameType(value: unknown): string | null {
  const raw = String(value ?? "");
  if (raw === TOWER.id) return TOWER.id;
  return gamePluginRegistry.has(raw) ? raw : null;
}

export function gameTypeLabel(value: unknown): string {
  const id = String(value ?? "");
  const found = listGameTypes().find((type) => type.id === id);
  return found?.label ?? TOWER.label;
}

/**
 * 全量标签映射（内置 tower + 全部已注册插件的展示名）。
 *
 * 这是展示名的**唯一源**：admin 端（TaskPacksPage）直接跨目录 import 这里，
 * 不再自带第三副本；新玩法只需在 server-plugins.ts 登记一行，标签随 manifest.title 自动生效。
 */
export function gameTypeLabels(): Record<string, string> {
  return Object.fromEntries(listGameTypes().map((type) => [type.id, type.label]));
}

/** 该玩法是否走插件引擎（非内置爬塔）。 */
export function isPluginGameType(value: unknown): boolean {
  const id = String(value ?? "");
  return gamePluginRegistry.has(id);
}

/**
 * 包级 18+ 判定（0106，/trial 门禁下沉的唯一切分点）：
 * - 爬塔（tower）：读 task_packs.adult 列（0106，管理端可编辑，默认 0）；
 * - 插件玩法：读清单现成的 capabilities.adult（src/game-plugin/types.ts:38，
 *   如 quest=true、其余=false）——插件协议不加列，包行上的 adult 列值
 *   对插件包不参与玩家侧判定。
 * 未知玩法按非 adult 处理（开局入口本来就拒绝未知玩法）。
 */
export function isAdultGamePack(pack: { gameType: string; adult: boolean }): boolean {
  if (pack.gameType === "tower") return pack.adult;
  return gamePluginRegistry.get(pack.gameType)?.manifest.capabilities.adult === true;
}

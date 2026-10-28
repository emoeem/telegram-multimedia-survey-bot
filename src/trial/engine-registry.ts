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

/** 该玩法是否走插件引擎（非内置爬塔）。 */
export function isPluginGameType(value: unknown): boolean {
  const id = String(value ?? "");
  return gamePluginRegistry.has(id);
}

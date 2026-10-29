import { registerGamePlugins } from "./registry";
import { flipCardPlugin } from "./plugins/flip-card/engine";
import { drawPlugin } from "./plugins/draw/engine";
import { questPlugin } from "./plugins/quest/engine";

/**
 * 服务端插件注册表——新增玩法时**唯一需要改动的文件**（加一行）。
 *
 * 客户端半身由 admin/src/game-plugins/loader.ts 用 import.meta.glob 自动发现，
 * 这里没有 glob 可用，只能显式登记；tests/unit/game-plugin/registry.test.ts
 * 会断言「插件目录集合 === 注册集合」，漏登记直接红。
 */
registerGamePlugins(flipCardPlugin);
registerGamePlugins(drawPlugin);
registerGamePlugins(questPlugin);

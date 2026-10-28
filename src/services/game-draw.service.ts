import { getTaskPackById } from "../db/repositories/task-pack.repository";

/**
 * 小游戏区的通用抽取：从一个任务包的启用条目里按权重随机抽 N 条。
 *
 * 权重 = 条目分值（score，至少 1）——分值高的任务更容易被抽到，这与爬塔
 * 玩法里"高分任务更稀缺"的直觉一致。认证卡联动（/api/cert/draw）与未来的
 * 抽取类玩法共用这个服务。
 */

export interface DrawnTaskItem {
  id: number;
  title: string;
  description: string;
  warning: string;
  score: number;
}

export interface DrawOptions {
  /** 身份过滤：male/female 时也保留 persona="any" 的条目；缺省不过滤。 */
  persona?: "male" | "female";
  /** 抽取条数（调用方已夹取到 1–5）。 */
  count: number;
  /** 随机源（测试注入）；生产 Math.random。 */
  random?: () => number;
}

/**
 * 从任务包抽取条目。包不存在返回 null；包内没有匹配条目返回空数组。
 * 加权不放回抽样：同一批内不重复，权重只影响入选概率不影响顺序。
 */
export async function drawTaskItems(
  db: D1Database,
  packId: number,
  options: DrawOptions,
): Promise<DrawnTaskItem[] | null> {
  const pack = await getTaskPackById(db, packId);
  if (!pack) return null;
  const pool = (pack.items ?? []).filter(
    (item) => item.enabled && (!options.persona || item.persona === "any" || item.persona === options.persona),
  );
  const random = options.random ?? Math.random;
  const results: DrawnTaskItem[] = [];
  const remaining = [...pool];
  while (remaining.length > 0 && results.length < options.count) {
    const totalWeight = remaining.reduce((sum, item) => sum + Math.max(1, item.score), 0);
    let pickAt = random() * totalWeight;
    let chosenIndex = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      pickAt -= Math.max(1, remaining[i]!.score);
      if (pickAt <= 0) {
        chosenIndex = i;
        break;
      }
    }
    const [chosen] = remaining.splice(chosenIndex, 1);
    if (!chosen) break;
    results.push({
      id: chosen.id,
      title: chosen.title,
      description: chosen.description,
      warning: chosen.warning,
      score: chosen.score,
    });
  }
  return results;
}

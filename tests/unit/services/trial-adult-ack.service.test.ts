import { beforeEach, describe, expect, it } from "vitest";

import {
  addTrialAdultAckedPack,
  getTrialAdultAck,
  parseAckedPackIds,
  setTrialAdultAckAll,
  trialAdultAckAllowsPack,
} from "../../../src/services/trial-adult-ack.service";
import { fullMigrationSchema } from "../../helpers/full-schema";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * /trial 包级 18+ ack 偏好（0104）的读写与判定：
 * - participant_preferences 两列（0080 同表）：全局 ack 标志 + 包级列表；
 * - 纯判定 trialAdultAckAllowsPack：全局或命中该包，任一即放行；
 * - 追加包 id 幂等（重复确认不膨胀），脏数据解析不抛错。
 */
describe.skipIf(!sqliteD1Available)("trial-adult-ack.service（0104 包级 ack 偏好）", () => {
  let db: D1Database;
  const HASH = "web_acksvc";

  beforeEach(() => {
    db = createSqliteD1(fullMigrationSchema());
  });

  it("无偏好行时返回未 ack 空态", async () => {
    expect(await getTrialAdultAck(db, HASH)).toEqual({ ackAll: false, ackedPackIds: [] });
  });

  it("setTrialAdultAckAll 置全局标志且幂等", async () => {
    await setTrialAdultAckAll(db, HASH);
    await setTrialAdultAckAll(db, HASH);
    expect(await getTrialAdultAck(db, HASH)).toEqual({ ackAll: true, ackedPackIds: [] });
  });

  it("addTrialAdultAckedPack 追加包 id、重复确认不膨胀", async () => {
    await addTrialAdultAckedPack(db, HASH, 7);
    await addTrialAdultAckedPack(db, HASH, 7);
    await addTrialAdultAckedPack(db, HASH, 12);
    const ack = await getTrialAdultAck(db, HASH);
    expect(ack.ackAll).toBe(false);
    expect(ack.ackedPackIds).toEqual([7, 12]);
  });

  it("全局标志与包级列表互不覆盖（同一名参与者既可全局又可包级）", async () => {
    await addTrialAdultAckedPack(db, HASH, 3);
    await setTrialAdultAckAll(db, HASH);
    const ack = await getTrialAdultAck(db, HASH);
    expect(ack).toEqual({ ackAll: true, ackedPackIds: [3] });
  });

  it("纯判定：全局或命中该包任一即放行，未命中不放行", () => {
    const ack = { ackAll: false, ackedPackIds: [5] };
    expect(trialAdultAckAllowsPack(ack, 5)).toBe(true);
    expect(trialAdultAckAllowsPack(ack, 6)).toBe(false);
    expect(trialAdultAckAllowsPack({ ackAll: true, ackedPackIds: [] }, 99)).toBe(true);
    // 语义锚点（复核修订②）：全局标志对所有包单向兼容放行。
    expect(trialAdultAckAllowsPack({ ackAll: true, ackedPackIds: [5] }, 5)).toBe(true);
  });

  it("parseAckedPackIds 容忍脏数据并去重有界", () => {
    expect(parseAckedPackIds(null)).toEqual([]);
    expect(parseAckedPackIds(undefined)).toEqual([]);
    expect(parseAckedPackIds("not-json")).toEqual([]);
    expect(parseAckedPackIds('{"a":1}')).toEqual([]);
    expect(parseAckedPackIds('[3, 3, "x", 0, -1, 1.5, 9]')).toEqual([3, 9]);
  });
});

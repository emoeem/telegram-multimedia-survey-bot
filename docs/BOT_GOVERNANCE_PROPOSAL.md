# Bot 流程与消息治理改造提案

> 状态：提案，等待单独批准后实施。本文档不授权修改现有流程状态、`/start`、`/cancel` 或消息渲染行为。
> 日期：2026-08-22。

## 1. 目标

在不重写 Bot、不改变答题数据模型的前提下，解决多条管理流程互相污染、状态长期残留和管理消息连续堆积的问题。

本提案覆盖：

- flow registry：集中登记 survey、template、identity、admin、import 等流程。
- 状态命名空间与 TTL：新键统一为 `flow:{name}:{userId}:{slot}`，默认 24 小时过期。
- `/start` 与 `/cancel` 语义：`/start` 清理全部交互流程；`/cancel` 只结束当前流程。
- 路由守卫：文本或媒体消息只交给当前 flow，命令始终优先。
- `renderUiScreen` 收敛：管理页面尽量编辑/替换同一条 UI 消息。
- 旧 KV 键和 callback 的兼容读取，避免正在进行的会话突然失效。

模板变量类型化另按 Phase 3 的模板项目实施，但复用本提案的流程边界和选择器交互规范。

## 2. 明确不在本次提案内

- 不替换现有 Bot 框架。
- 不修改问卷答题会话的 Durable Object 数据结构。
- 不删除历史命令或 callback handler；仅可隐藏入口并保留兼容期。
- 不与 Phase 2.7 菜单瘦身混合发布。
- 不同时实施 Telegraph 管线、Web 媒体库或模板数据迁移。

## 3. 建议设计

新增 `src/bot/flow-state.ts`，由一个注册表描述每类流程的状态键、互斥关系、默认 TTL 和返回入口：

```ts
type FlowName = "survey" | "template" | "identity" | "admin" | "import";

interface FlowDefinition {
  legacyKeys: (userId: number) => string[];
  ttlSeconds: number;
  conflictsWith: FlowName[];
}
```

对外只暴露 `enterFlow`、`getCurrentFlow`、`getFlowState`、`setFlowState`、`resetFlow`、`resetAllFlows`。业务 handler 不再自行拼接新 KV 键。

路由顺序固定为：

1. 识别 `/start`、`/cancel` 和其他明确命令。
2. 读取当前 flow 并只分发给对应 handler。
3. 没有活动 flow 时再进入普通答题、搜索和首页路由。
4. 未消费的输入返回当前页面提示，不跨流程猜测用途。

## 4. 兼容与迁移策略

- 首次读取新键失败时读取旧键；后续写入新命名空间并删除对应旧键。
- 旧 callback handler 至少保留一个完整发布周期，入口可提前隐藏。
- 答题中的 response/session 不属于管理 flow；`/cancel` 是否取消答题继续沿用当前产品语义，实施前单列验收用例。
- 每个迁移步骤独立提交，禁止一次性替换所有 handler。

建议拆分为四个可回滚批次：

1. 引入注册表和兼容适配器，不改变路由行为。
2. 迁移 admin/import/template/identity 状态键。
3. 启用路由守卫并明确 `/start`、`/cancel` 行为。
4. 收敛管理 UI 到 `renderUiScreen`，清理确认无调用的旧状态写入。

## 5. 验收标准

- 任意流程进行中发送 `/start` 都能回首页，且不再被当作文本或媒体输入。
- `/cancel` 只清当前管理流程，不误删无关状态。
- 从模板、身份卡、导入、管理员搜索之间切换不会互相消费输入。
- 新状态均有 TTL；代码中不再新增未登记的 per-user 流程键。
- 同一管理流程连续操作时不产生无界消息堆积。
- 存量旧键和旧 callback 在兼容期内仍可完成或安全退出。
- 单元测试覆盖命令优先级、互斥 flow、TTL、旧键迁移和失败清理；staging 做真实 Telegram 回归。

## 6. 风险与上线方式

主要风险是错误清理仍在使用的状态，以及路由守卫阻断历史边界路径。实施时需增加结构化日志（flow、事件、结果，不记录用户输入和密码），先在 staging 启用，再以可关闭的配置开关逐步上线。

在用户再次确认本提案前，项目只保留现有治理逻辑和 Phase 2.7 的入口瘦身。

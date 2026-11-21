# Figma 导入指南（FIGMA_IMPORT_GUIDE）

> 状态如实声明（2026-11-22）：**Figma MCP 本次未执行任何写入**——计划 §0/§8.2 明确不在额度受限时反复调用；现有 Figma 文件（sgD7JvzrkngswriJXjgUmB）保持空白，**不将其伪称为设计交付**。本文档为「通道可用时的导入路径 + 人工重建资料」。

## 1. 通道优先级（按计划 §8.2）

| 优先级 | 通道                         | 前置条件                | 动作                                                                             |
| ------ | ---------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| 1      | Figma MCP（Plugin API 写入） | Starter 计划额度恢复    | 由 token 与页面规范构建真实 Frame/Text/Vector/Component/Variables                |
| 2      | html.to.design 等导入插件    | 用户 Figma 桌面端可操作 | 导入 `prototype-lab/pages/*.html`（登录态/错误态逐个状态导入），验证图层可编辑性 |
| 3      | 人工重建                     | 无自动通道              | 按本文 §3 逐屏规范 + tokens.json 重建；完成后对照截图验收                        |

## 2. 导入素材索引

| 素材        | 路径                                                       | 用途                                                                    |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| 可运行原型  | `prototype-lab/pages/*.html`（html.to.design 直接吃 HTML） | 图层化导入                                                              |
| 设计 tokens | `docs/design/tokens.json`                                  | 建 Figma Variables（Color/Space/Radius/Type 四集合，dark/light 两模式） |
| 视觉对照    | `prototype-lab/screenshots/*.png`（19 张，多视口）         | 逐屏验收基准                                                            |
| 组件清单    | `docs/design/COMPONENT_INVENTORY.md`                       | 建 Figma Components 与变体（按钮 5 变体 × 4 尺寸 × 3 态等）             |
| 布局规则    | `docs/design/RESPONSIVE_RULES.md`                          | 每屏建 Auto Layout + 断点变体                                           |

## 3. 逐屏重建规范（通道 3 使用）

每屏 = 一个 Frame，命名 `Page/Viewport/State`，如 `Room/Mobile-390/JoinError`。通用规格：

- 页面栅格：Desktop 内容最大宽 1120 + 24px 边距；后台图标轨 60；顶栏高 56。
- 排版：Display 26/650 · Title 19/600 · Subtitle 16/600 · Body 14/400 · Caption 12/400（中文优先 PingFang SC / Noto Sans CJK SC）。
- 颜色/间距/圆角/阴影：全部引用 §2 tokens（禁止取色器近似值）。
- 组件实例化：按钮/输入/chip/卡片/开关/抽屉先建 Component 再放 Instance；状态用 Variants（如 Button/variant=primary|secondary|ghost|danger, size=sm|md|lg, state=default|loading|disabled）。
- 必建状态屏（来自 PROTOTYPE_REVIEW/USER_FLOWS）：Dashboard 8 态、Room 13 态、Profile 7 态中至少各取 高频 4 态 + 1 错误态。

## 4. 导入后验收清单（不通过不算交付）

- [ ] 图层树按语义分组（非整屏扁平位图）
- [ ] 文本均为可编辑 Text 节点，中文字体未丢字重
- [ ] 按钮/输入/卡片为 Component + Instance，且状态为 Variants
- [ ] 颜色/间距绑定 Variables（改 token 全局生效）
- [ ] 每屏 Auto Layout 正确，窗口缩放不散架
- [ ] 与截图对照逐屏走查（允许 2px 内誊差）

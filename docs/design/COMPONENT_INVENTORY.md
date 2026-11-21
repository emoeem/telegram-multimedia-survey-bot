# 组件清单（COMPONENT_INVENTORY）

> 原型实现：`prototype-lab/assets/base.css`（类名即契约）。M4+ 产品落地时的映射目标一并列出，落地时以 tokens.json 为准，不得为单页发明新变体。

## 1. 基础组件

| 组件         | 原型类                        | 变体 / 状态                                                                                                      | 使用页面                                       | 产品落地映射                                     |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| 按钮         | `.btn`                        | `-primary`(金) `-secondary` `-ghost` `-danger` `-on-gold`；`-sm/-md/-lg/-block`；`:disabled` `.is-loading`(转圈) | 全部                                           | 现有 `btn btn-primary`（daisyUI）扩展 loading 态 |
| 图标按钮     | `.icon-btn`                   | hover/focus                                                                                                      | 后台顶栏、抽屉头                               | `survey-icon-btn`                                |
| 徽标 chip    | `.chip`                       | 中性 `-gold -success -warning -danger -info`；`.chip-select`(可点筛选)                                           | 全部                                           | 新建 `SurveyChip` 或沿用 span+class              |
| 状态点       | `.dot`                        | `-success -warning -danger -info`                                                                                | 队列、通知                                     | 新增                                             |
| 卡片         | `.card`                       | `-elevated` `-interactive` `.is-selected`                                                                        | 全部                                           | `survey-card`                                    |
| 输入         | `.input .select .textarea`    | focus 金色 ring；`.is-error` + `.field-error`；`.field-label/-help`                                              | 全部                                           | 现有 input 样式补 error/focus 规范               |
| 开关         | `.switch`                     | checked=金                                                                                                       | 音效偏好                                       | 新增（现用 checkbox）                            |
| 滑杆         | `.slider`                     | accent 金                                                                                                        | 音量                                           | 新增                                             |
| 分段控件     | `.seg` `.seg-btn`             | `aria-selected`；`data-view` 驱动面板                                                                            | 大厅二级导航、试炼设置、登录/注册              | 新增（对应现 radio 组的可访问化）                |
| Tabs         | `.tabs .tab`                  | 下划线金                                                                                                         | （备用）                                       | 新增                                             |
| Modal        | `.overlay` + `.modal`         | Escape/遮罩点击关闭、焦点圈定、`proto-overlay-open` 时原型面板让位                                               | 登录、规则、足迹                               | 对齐 `ThemePickerSheet` 类弹层                   |
| Drawer       | `.drawer .drawer-right/-left` | 头/体/脚三段                                                                                                     | 后台导航、工作区详情、报告详情、金币明细、通知 | 后台现用滑出抽屉（`Layout.tsx:277`）规范化       |
| Bottom Sheet | `.sheet` + `.sheet-grabber`   | 移动端底部弹出，≥640px 变居中卡                                                                                  | 大厅游戏详情（移动）                           | 新增                                             |
| Toast        | `.toast`（JS 注入）           | 2.2s 自动消失                                                                                                    | 全部反馈                                       | 新增（替代 alert 式反馈）                        |
| Skeleton     | `.skeleton -text/-block`      | shimmer；reduced-motion 下静止                                                                                   | Dashboard 加载态                               | 新增                                             |
| 空态/错误态  | `.state-block`                | 图标+标题+说明+动作                                                                                              | 队列空态、全局错误、无权限、占位页             | 新增                                             |
| 表格         | `.table` + `.table-scroll`    | 移动端自动转字段卡（`td[data-label]` + `::before`）                                                              | 报告队列、排行榜                               | 对齐现有 `tbl`                                   |
| 批量操作栏   | `.batchbar`                   | 选中>0 浮出（移动端固定底部）                                                                                    | 报告队列                                       | 新增                                             |

## 2. 业务组件（M1 四页）

| 组件           | 原型类                                                           | 说明                                                         |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 后台图标轨     | `.adm-rail .rail-item`                                           | 60px；≤1023px 隐藏，改顶栏汉堡 → 左抽屉                      |
| 后台顶栏       | `.adm-topbar .breadcrumb .env-chip`                              | 面包屑 + 搜索 + 环境徽标                                     |
| 工作区地图卡   | `.workspace-grid .workspace-card .ws-num .ws-counts .ws-modules` | 问卷工作区 `.is-primary` 强调；点卡开详情抽屉                |
| KPI 卡         | `.kpi-grid .kpi .kpi-value`                                      | 5→3→2 列；`.is-error/.is-refreshing`                         |
| 游戏卡         | `.game-card .game-icon .game-meta .game-desc`                    | 大厅列表项；`.is-selected`                                   |
| 游戏详情面板   | `.lobby-detail`                                                  | 桌面右栏 sticky；含开局设置（仅服务端已实现项）              |
| 单人试炼设置卡 | `#trial-settings`                                                | 身份 公/母、模式 普通/地狱（对应 TrialScreen，勿与联机混淆） |
| 玩法选择卡     | `.game-option .opt-pick`                                         | 房间页大命中区；选中描金 + 「已选」                          |
| 房间码         | `.room-code`                                                     | mono 大字 + 虚线框；复制按钮双态                             |
| 座位槽         | `.seat-row .seat(-empty)`                                        | 等待大厅；演示对手加入                                       |
| 金币卡         | `.coin-card .coin-actions`                                       | 金色渐变、深色按钮；不挤占其他入口                           |
| 身份卡         | `.avatar .identity-row`                                          | 匿名/已登录双态                                              |
| 列表行         | `.row-item .row-icon .row-body .row-extra`                       | 个人中心分组行（未读徽标/箭头/内嵌按钮）                     |
| 用户端顶导航   | `.topnav .topnav-link`                                           | ≥900px 显示                                                  |
| 底部导航       | `.bottomnav .bottomnav-item`                                     | <900px 显示；6 项；safe-area；44px 命中                      |
| TG 宿主栏模拟  | `.tg-hostbar` + `.tg-note`（`ProtoUI.applyTgFrame`）             | `?frame=tg` 时接管页面导航（M4 统一共享实现，用户端三页）    |
| 房间帮助卡     | `#room-help .help-list`                                          | 房间码/邀请链接/超时规则说明（仅引用已实现规则，不虚构）     |
| 成就墙入口行   | `#achievement-entry`                                             | 对应真实产品 AchievementWall；原型为 toast 演示              |
| 原型控制浮层   | `.proto-panel`（34px 圆形按钮 + 状态面板）                       | 弹层打开自动让位；移动端抬到底部导航之上                     |

## 3. 状态覆盖约定

每个页面必须实现（原型已带状态机，URL `?state=` 驱动）：

- Dashboard：正常/加载/零数据/请求失败/部分失败/无权限/队列异常/刷新中
- Room：默认/选中玩法/创建中/创建成功(Mock)/复制完成/校验中/空码/格式错/不存在/满员/已结束/网络失败/加入成功/等待开局
- Profile：匿名/已登录/余额失败/已签到/无报告/足迹链接撤销/通知已读
- Games：默认/选中游戏/分类空/记录/排行榜/移动端 Sheet

弹层规范：所有浮层 `hidden` 属性控制显隐，`[hidden]{display:none!important}` 保证显隐优先级（M2 修复教训，产品落地时同样适用）；Escape 关闭最上层并归还焦点。

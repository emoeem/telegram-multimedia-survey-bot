/* 认证卡生成器 —— 内置主题数据
 *
 * 每套主题都是中立、无敏感内容的趣味认证，字段含义：
 *   cardLabel  卡片右上角徽标文字
 *   issuer     发证机构（页眉 + 页脚）
 *   subtitle   页眉英文副标题
 *   sealText   印章环文字
 *   palette    配色
 *   groups     分组标签库（emoji + 组名 + 标签），可勾选 / 增删 / 改名，
 *              用户还可以在任意分组里「+ 自己加」
 *   ranks      等级称号区间（按百分比命中）
 *
 * 用户在界面上的改动会写入 localStorage，可通过「恢复默认」还原到这里的值。
 */
window.CERT_THEMES = [
  {
    id: "worker",
    name: "打工人执业认证",
    cardLabel: "执业资格证",
    issuer: "全国打工人执业资格认证中心",
    subtitle: "CERTIFICATE OF EMPLOYMENT",
    sealText: "打工人执业认证专用章",
    palette: {
      primary: "#1e3a8a",
      primary2: "#2563eb",
      accent: "#f59e0b",
      ink: "#0f172a",
      muted: "#64748b",
      paper: "#f7f9fc",
    },
    groups: [
      {
        emoji: "💼",
        name: "职场日常",
        tags: ["摸鱼时长超标", "加班抗性拉满", "会议生存率选手", "周会假装在听", "弹性工作弹性", "已读不回战术家"],
      },
      {
        emoji: "☕",
        name: "精神状态",
        tags: ["咖啡因依赖症", "离职幻想常客", "日报编造大师", "需求变更免疫"],
      },
      {
        emoji: "🤝",
        name: "社交战场",
        tags: ["甲方沟通达人", "团建积极分子"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "实习牛马" },
      { min: 20, max: 40, name: "正式牛马" },
      { min: 40, max: 60, name: "资深牛马" },
      { min: 60, max: 80, name: "金牌牛马" },
      { min: 80, max: 100, name: "传说牛马" },
    ],
  },
  {
    id: "cat",
    name: "猫奴执照",
    cardLabel: "猫奴执照",
    issuer: "国际猫奴资格认证委员会",
    subtitle: "CAT SERVANT LICENSE",
    sealText: "猫奴资格认证专用章",
    palette: {
      primary: "#7e22ce",
      primary2: "#a855f7",
      accent: "#f472b6",
      ink: "#1f1235",
      muted: "#6b7280",
      paper: "#faf7fd",
    },
    groups: [
      {
        emoji: "🧹",
        name: "日常供奉",
        tags: ["每日铲屎不辍", "猫粮囤积大户", "猫砂清洁强迫症", "罐头供奉准时", "猫抓板采购员"],
      },
      {
        emoji: "🐾",
        name: "相处之道",
        tags: ["被踩醒也不恼", "呼噜声接收良好", "沙发被挠仍爱它", "半夜跑酷耐受", "撸猫手法专业", "猫毛加餐习惯"],
      },
      {
        emoji: "📷",
        name: "铲屎官修养",
        tags: ["主子摄影十级"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "见习铲屎官" },
      { min: 20, max: 40, name: "正式铲屎官" },
      { min: 40, max: 60, name: "资深铲屎官" },
      { min: 60, max: 80, name: "金牌铲屎官" },
      { min: 80, max: 100, name: "猫奴之王" },
    ],
  },
  {
    id: "dev",
    name: "程序员段位证书",
    cardLabel: "段位证书",
    issuer: "全球程序员段位评定委员会",
    subtitle: "PROGRAMMER RANK CERTIFICATE",
    sealText: "程序员段位评定专用章",
    palette: {
      primary: "#065f46",
      primary2: "#10b981",
      accent: "#f97316",
      ink: "#0b2119",
      muted: "#6b7280",
      paper: "#f6fbf9",
    },
    groups: [
      {
        emoji: "🔨",
        name: "日常产出",
        tags: ["Bug 制造机", "重构冲动症", "注释缺失嫌疑", "缩进强迫症", "命名困难户"],
      },
      {
        emoji: "🧠",
        name: "玄学功力",
        tags: ["Stack Overflow 依赖", "本地跑得好好的", "需求理解偏差", "调试耐心超常"],
      },
      {
        emoji: "🚀",
        name: "上线勇气",
        tags: ["文档恐惧症", "上线胆量十足", "咖啡因转化率高"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "倔强黑铁" },
      { min: 20, max: 40, name: "秩序青铜" },
      { min: 40, max: 60, name: "荣耀白银" },
      { min: 60, max: 80, name: "尊贵黄金" },
      { min: 80, max: 100, name: "最强王者" },
    ],
  },
  {
    id: "coffee",
    name: "咖啡品鉴师认证",
    cardLabel: "品鉴师证",
    issuer: "亚洲咖啡品鉴师协会",
    subtitle: "COFFEE TASTER CERTIFICATE",
    sealText: "咖啡品鉴师认证专用章",
    palette: {
      primary: "#7c2d12",
      primary2: "#c2410c",
      accent: "#fbbf24",
      ink: "#241009",
      muted: "#78716c",
      paper: "#fdf8f4",
    },
    groups: [
      {
        emoji: "☕",
        name: "摄入强度",
        tags: ["每日三杯起步", "浓缩耐受度高", "深夜咖啡无碍", "戒断宣告失败", "冷萃四季不停"],
      },
      {
        emoji: "🎨",
        name: "手艺修养",
        tags: ["手冲技艺娴熟", "拉花勉强能看", "产区辨识初阶", "器具收藏爱好者"],
      },
      {
        emoji: "🛒",
        name: "生活方式",
        tags: ["豆子囤积成癖", "酸度接受良好", "随身挂耳常备"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "咖啡萌新" },
      { min: 20, max: 40, name: "日常续命" },
      { min: 40, max: 60, name: "咖啡爱好者" },
      { min: 60, max: 80, name: "资深品鉴师" },
      { min: 80, max: 100, name: "咖啡因之神" },
    ],
  },
  {
    id: "gamer",
    name: "玩家段位认证",
    cardLabel: "段位认证书",
    issuer: "全球玩家水平评定中心",
    subtitle: "PLAYER RANK CERTIFICATE",
    sealText: "玩家段位评定专用章",
    palette: {
      primary: "#1e1b4b",
      primary2: "#4f46e5",
      accent: "#22d3ee",
      ink: "#141033",
      muted: "#6b7280",
      paper: "#f7f8fd",
    },
    groups: [
      {
        emoji: "🎮",
        name: "操作实力",
        tags: ["手速跟得上意识", "补刀稳如老狗", "操作偶尔超神", "装备搭配合理"],
      },
      {
        emoji: "🗺️",
        name: "游戏理解",
        tags: ["地图熟到闭眼走", "版本更新跟得上", "录像复盘习惯", "队友沟通顺畅"],
      },
      {
        emoji: "💪",
        name: "精神属性",
        tags: ["连败也不下线", "心态从不爆炸", "外设信仰充值", "成就收集强迫症"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "新手村村民" },
      { min: 20, max: 40, name: "进阶冒险者" },
      { min: 40, max: 60, name: "老练挑战者" },
      { min: 60, max: 80, name: "精英选手" },
      { min: 80, max: 100, name: "传说级玩家" },
    ],
  },
  {
    id: "fitness",
    name: "健身打卡执照",
    cardLabel: "健身执照",
    issuer: "全民健身打卡认证中心",
    subtitle: "FITNESS CHECK-IN LICENSE",
    sealText: "健身打卡认证专用章",
    palette: {
      primary: "#0f766e",
      primary2: "#14b8a6",
      accent: "#f97316",
      ink: "#0b2b28",
      muted: "#6b7280",
      paper: "#f5fbfa",
    },
    groups: [
      {
        emoji: "🏋️",
        name: "训练纪律",
        tags: ["每周三练不断", "深蹲姿势标准", "核心训练坚持", "拉伸从不跳过", "休息日也拉伸"],
      },
      {
        emoji: "🥗",
        name: "饮食恢复",
        tags: ["蛋白粉按时喝", "水杯从不离手", "练后酸痛依旧去"],
      },
      {
        emoji: "🌅",
        name: "生活习惯",
        tags: ["跑步机上刷剧", "体重记录习惯", "早起晨跑选手", "器械区不占位"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "办卡即巅峰" },
      { min: 20, max: 40, name: "规律出勤" },
      { min: 40, max: 60, name: "稳定进阶" },
      { min: 60, max: 80, name: "训练狂人" },
      { min: 80, max: 100, name: "健身房传说" },
    ],
  },
  {
    id: "foodie",
    name: "美食鉴赏家认证",
    cardLabel: "鉴赏家证",
    issuer: "亚洲美食鉴赏家协会",
    subtitle: "FOOD CRITIC CERTIFICATE",
    sealText: "美食鉴赏家认证专用章",
    palette: {
      primary: "#9d174d",
      primary2: "#e11d48",
      accent: "#fbbf24",
      ink: "#2a0a14",
      muted: "#78716c",
      paper: "#fdf7f8",
    },
    groups: [
      {
        emoji: "🍜",
        name: "探店功力",
        tags: ["探店打卡成瘾", "排队两小时也去", "收藏夹全是店", "地方小吃通吃"],
      },
      {
        emoji: "👅",
        name: "味觉修行",
        tags: ["辣度接受度高", "汤底一口辨好坏", "甜咸党争中立", "食材新鲜度敏感"],
      },
      {
        emoji: "📸",
        name: "吃货日常",
        tags: ["拍照先于动筷", "夜宵从不缺席", "厨房翻车常客", "外卖备注小作文"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "随便吃吃" },
      { min: 20, max: 40, name: "日常觅食" },
      { min: 40, max: 60, name: "资深吃货" },
      { min: 60, max: 80, name: "民间美食家" },
      { min: 80, max: 100, name: "味觉宗师" },
    ],
  },
  {
    id: "sleep",
    name: "熬夜修仙等级证",
    cardLabel: "修仙等级证",
    issuer: "全国熬夜修仙等级评定委员会",
    subtitle: "NIGHT OWL LEVEL CERTIFICATE",
    sealText: "熬夜等级评定专用章",
    palette: {
      primary: "#312e81",
      primary2: "#6366f1",
      accent: "#a78bfa",
      ink: "#161344",
      muted: "#6b7280",
      paper: "#f8f8fd",
    },
    groups: [
      {
        emoji: "🌙",
        name: "熬夜功力",
        tags: ["凌晨两点仍清醒", "再刷一集就睡", "通宵经验值满", "熄灯后再聊五分钟"],
      },
      {
        emoji: "⏰",
        name: "作息状态",
        tags: ["闹钟平均五个", "早八永远挣扎", "周末补觉八小时", "黑眼圈常驻"],
      },
      {
        emoji: "📱",
        name: "夜间活动",
        tags: ["深夜灵感爆发", "睡前必刷手机", "午夜食堂熟客", "白天靠咖啡续命"],
      },
    ],
    ranks: [
      { min: 0, max: 20, name: "养生达人" },
      { min: 20, max: 40, name: "轻度熬夜" },
      { min: 40, max: 60, name: "常态化修仙" },
      { min: 60, max: 80, name: "资深夜行侠" },
      { min: 80, max: 100, name: "修仙渡劫期" },
    ],
  },
];

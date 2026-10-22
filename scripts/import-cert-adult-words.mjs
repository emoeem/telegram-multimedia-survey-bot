/* 一次性导入脚本：把外站词库（js/words.js）转成认证卡生成器能吃的主题包
 *
 * 用法：node scripts/import-cert-adult-words.mjs <words.js 路径>
 *      默认读 /tmp/seal-words.js（来源站点 seal.jiyu12.com/js/words.js，已获作者授权）
 *
 * 产出：cert/themes-adult.js —— window.CERT_ADULT_THEMES，只在用户确认 18+ 之后才被
 *       app.js 动态注入浏览器，未确认前这份词表不会出现在页面里。
 *
 * 转换规则：
 *   SECTIONS_RAW 的 items 是「<性别><分值> <词条>」多行文本，源站自己用正则解析；
 *   这里仍然调 源站 words.js 里的 SECTIONS，保证解析口径完全一致，再原样搬 19 个板块。
 *   RANKS 的 min 之间补出 max（下一档 -1，末档 999）；等级用 pct = raw/60*100 算，
 *   所以档位可以超过 100%，和源站一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = process.argv[2] || '/tmp/seal-words.js';
const raw = fs.readFileSync(src, 'utf8');

/* words.js 是纯数据（无 DOM），在沙箱里跑一遍直接拿到导出量：
 * 顶层 const 在 vm 里是词法绑定、不会挂到 context 对象上，所以末尾追加一句显式导出 */
const ctx = vm.createContext({});
vm.runInContext(
  raw +
    '\n;globalThis.__VOCAB = { SECTIONS, SECTIONS_RAW, TITLE_PRESETS, RANKS, SECTION_TYPES, BINGO_CLASSIC };',
  ctx,
  { filename: src },
);
const { SECTIONS, TITLE_PRESETS, RANKS, SECTION_TYPES } = ctx.__VOCAB;

if (!Array.isArray(SECTIONS) || !SECTIONS.length) throw new Error('解析 SECTIONS 失败：' + src);
if (!Array.isArray(RANKS) || !RANKS.length) throw new Error('解析 RANKS 失败：' + src);

const groups = SECTIONS.map((sec) => ({
  emoji: sec.icon,
  name: sec.name,
  badge: sec.badge,
  tags: sec.items.map((it) => ({ t: it.t, s: it.s, g: it.g })),
}));

let total = 0;
groups.forEach((g) => {
  total += g.tags.length;
});

const ranks = RANKS.map((r, i) => {
  const next = RANKS[i + 1];
  return {
    min: r.min,
    max: next ? next.min - 1 : 999,
    grade: r.grade,
    rare: r.rare,
    f: r.f,
    m: r.m,
    say: r.say,
  };
});

const theme = {
  id: 'jiyu-adult',
  name: '成人向 · 骚货认证局',
  adult: true,
  genderAware: true,
  metric: { kind: 'score', divisor: 60 },
  cardLabel: '骚货认证',
  issuer: '骚货认证局',
  subtitle: 'SAOHUO CREDENTIAL BUREAU',
  sealText: '骚货认证局 · 持证上岗 · ',
  palette: {
    primary: '#e11d48',
    primary2: '#f43f5e',
    accent: '#be123c',
    ink: '#2a0b16',
    muted: '#9f7484',
    paper: '#fff5f7',
  },
  titles: { f: TITLE_PRESETS.f, m: TITLE_PRESETS.m },
  sectionTypes: Object.keys(SECTION_TYPES).reduce((acc, id) => {
    const t = SECTION_TYPES[id];
    acc[id] = { f: t.f, m: t.m, adj: t.adj, say: t.say };
    return acc;
  }, {}),
  ranks,
  groups,
};

/* 词条一行一条（1050 条 × 2 格缩进会有 1 万多行，压成一行一条既省体积也能 diff） */
const J = (v) => JSON.stringify(v);
const tagLines = (tags) =>
  tags.map((t) => '          { t: ' + J(t.t) + ', s: ' + t.s + ', g: ' + J(t.g) + ' },').join('\n');

const groupSrc = groups
  .map(
    (g) =>
      '    {\n' +
      '      emoji: ' + J(g.emoji) + ',\n' +
      '      name: ' + J(g.name) + ',\n' +
      '      badge: ' + J(g.badge) + ',\n' +
      '      tags: [\n' +
      tagLines(g.tags) +
      '\n      ],\n' +
      '    },',
  )
  .join('\n');

const rankSrc = ranks
  .map((r) => '    ' + J(r) + ',')
  .join('\n');

const typeSrc = Object.keys(theme.sectionTypes)
  .map((id) => '    ' + J(id) + ': ' + J(theme.sectionTypes[id]) + ',')
  .join('\n');

const rest = {
  id: theme.id,
  name: theme.name,
  adult: true,
  genderAware: true,
  metric: theme.metric,
  cardLabel: theme.cardLabel,
  issuer: theme.issuer,
  subtitle: theme.subtitle,
  sealText: theme.sealText,
  palette: theme.palette,
  titles: theme.titles,
};

const body =
  '/* 认证卡生成器 —— 成人向主题包（由 scripts/import-cert-adult-words.mjs 生成，勿手改）\n' +
  ' *\n' +
  ' * 来源：seal.jiyu12.com/js/words.js（作者已授权使用）。\n' +
  ' * ' + groups.length + ' 个板块 / ' + total + ' 条词条，每条带性别（u 通用 / f 雌性 / m 雄性）与分值（1 轻 / 2 中 / 3 重）。\n' +
  ' * 强度按分值累加后除以 ' + theme.metric.divisor + ' 折算成百分比，可超过 100%，与来源站同口径。\n' +
  ' *\n' +
  ' * 这个文件只在用户点了「我已满 18 岁」之后才被动态加载（见 app.js 的 loadAdultPack），\n' +
  ' * 未确认前页面里不存在任何一条成人词条。\n' +
  ' */\n' +
  'window.CERT_ADULT_THEMES = [\n' +
  '  Object.assign(' + J(rest) + ', {\n' +
  '    sectionTypes: {\n' + typeSrc + '\n    },\n' +
  '    ranks: [\n' + rankSrc + '\n    ],\n' +
  '    groups: [\n' + groupSrc + '\n    ],\n' +
  '  }),\n' +
  '];\n';

const out = path.join(process.cwd(), 'cert', 'themes-adult.js');
fs.writeFileSync(out, body);
console.log('写出 ' + out);
console.log('板块 ' + groups.length + ' / 词条 ' + total + ' / 档位 ' + ranks.length);
groups.forEach((g) => console.log('  ' + g.emoji + ' ' + g.name + ' (' + g.tags.length + ')  ' + g.badge));

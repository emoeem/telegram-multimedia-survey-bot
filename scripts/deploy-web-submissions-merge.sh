#!/usr/bin/env bash
#
# 免登录投稿并轨 —— 一键部署脚本(方案 B 上线)。
#
# 把 docs/ops/WEB_SUBMISSIONS_MERGE.md 的六步固化成可重跑的分段脚本:
#   1. 预检(命令、目录、依赖)
#   2. D1 migration 0088(无破坏性,CREATE IF NOT EXISTS)
#   3. 旧库导出 + 转换 + 导入(可选,--skip-data 跳过)
#   4. 部署本站 Worker(含 admin 构建)
#   5. 部署 cn-relay(删除了 /api/submit 直达路由的版本;必须在 Worker 之后)
#   6. 配置 SUBMISSION_BOT_LEGACY_TOKEN(可选,预览旧投稿附件)
#   7. 线上验证(form 接口双域名探测)
#
# 用法:
#   bash scripts/deploy-web-submissions-merge.sh              # 全流程(逐段确认)
#   bash scripts/deploy-web-submissions-merge.sh --yes        # 全流程不确认
#   bash scripts/deploy-web-submissions-merge.sh --skip-data  # 不迁历史数据
#   bash scripts/deploy-web-submissions-merge.sh --skip-relay # 不动中继(已部署过)
#   bash scripts/deploy-web-submissions-merge.sh --verify-only # 只跑验证段
#
# 旧账号凭据(第 3 段需要,缺了会跳过并提示手动操作):
#   WEBMERGE_OLD_CF_TOKEN   旧账号(fb8f4c…)的 API Token(D1 读取权限即可)
#   WEBMERGE_OLD_BOT_DIR    旧项目路径,默认 /home/emo/code/bot
#   WEBMERGE_OLD_DB         旧 D1 名,默认 submission-bot-db
#
# 旧附件只读 token(第 6 段需要;不从环境读,交互输入,避免落进 shell 历史):
#   交互粘贴旧机器人的 BOT_TOKEN 即可,或 --skip-secret 跳过。
#
set -euo pipefail

# ---------------------------------------------------------------------------
# 参数与常量
# ---------------------------------------------------------------------------

ASSUME_YES=0
SKIP_DATA=0
SKIP_RELAY=0
SKIP_SECRET=0
VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --skip-data) SKIP_DATA=1 ;;
    --skip-relay) SKIP_RELAY=1 ;;
    --skip-secret) SKIP_SECRET=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg(见 --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD_BOT_DIR="${WEBMERGE_OLD_BOT_DIR:-/home/emo/code/bot}"
OLD_DB="${WEBMERGE_OLD_DB:-submission-bot-db}"
DUMP_FILE="${WEBMERGE_DUMP:-/tmp/submission-bot-dump.sql}"
IMPORT_FILE="${WEBMERGE_IMPORT:-/tmp/web-submissions-import.sql}"
MAIN_ORIGIN="https://emoe.eu.cc"
RELAY_ORIGIN="https://emoemok.top"

# ---------------------------------------------------------------------------
# 输出辅助
# ---------------------------------------------------------------------------

info()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

stage() {
  printf '\n\033[1;36m━━ %s ━━\033[0m\n' "$*"
  if [[ $ASSUME_YES -eq 0 ]]; then
    read -r -p "继续? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "在「$*」前中止(未做任何更改)。"
  fi
}

# ---------------------------------------------------------------------------
# 1. 预检
# ---------------------------------------------------------------------------

stage "1/7 预检"
cd "$ROOT"
command -v pnpm  >/dev/null || die "缺 pnpm"
command -v node  >/dev/null || die "缺 node"
command -v curl  >/dev/null || die "缺 curl"
node -e "require('node:fs').accessSync('db/migrations/0088_web_submissions_merge.sql')" \
  || die "找不到 migration 0088 —— 请确认代码已切换到并轨分支"
[[ -f "scripts/migrate-web-submissions.mjs" ]] || die "缺少迁移脚本 scripts/migrate-web-submissions.mjs"

info "安装依赖(根 + admin)…"
pnpm install --frozen-lockfile --silent
(cd admin && pnpm install --frozen-lockfile --silent)
ok "预检通过:$(node --version),仓库 $ROOT"

# 本站 wrangler 是否已登录/有凭据(不登录也能跑到这里,deploy 会明确报错)
if ! pnpm exec wrangler whoami >/dev/null 2>&1; then
  warn "wrangler 未认证:主账号请先 wrangler login 或导出 CLOUDFLARE_API_TOKEN。"
fi

if [[ $VERIFY_ONLY -eq 1 ]]; then
  info "--verify-only:跳到第 7 段。"
  SKIP_DATA=1; SKIP_RELAY=1; SKIP_SECRET=1
fi

# ---------------------------------------------------------------------------
# 2. D1 migration
# ---------------------------------------------------------------------------

stage "2/7 应用 D1 migration 0088(幂等,可重跑)"
pnpm exec wrangler d1 migrations apply DB --remote
ok "迁移已应用。"

# ---------------------------------------------------------------------------
# 3. 历史数据迁移
# ---------------------------------------------------------------------------

if [[ $SKIP_DATA -eq 1 ]]; then
  warn "--skip-data:跳过历史数据迁移。"
else
  stage "3/7 迁移历史数据(旧账号 → 本站 D1)"

  already=$(pnpm exec wrangler d1 execute DB --remote --json \
    --command "SELECT COUNT(*) AS n FROM web_submissions" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log('-1')}})")
  if [[ "$already" != "-1" && "$already" != "0" ]]; then
    warn "web_submissions 已有 $already 行 —— 不重复导入(避免主键冲突覆盖新状态)。"
    info "确要重导:先手动清表(见 docs/ops/WEB_SUBMISSIONS_MERGE.md 回滚节)。"
  else
    if [[ -n "${WEBMERGE_OLD_CF_TOKEN:-}" ]]; then
      info "用环境变量提供的旧账号 token 导出旧库…"
      (cd "$OLD_BOT_DIR" && CLOUDFLARE_API_TOKEN="$WEBMERGE_OLD_CF_TOKEN" \
        npx wrangler d1 export "$OLD_DB" --remote --output "$DUMP_FILE" --skip-confirmation)
    elif [[ -d "$OLD_BOT_DIR" ]]; then
      info "用 $OLD_BOT_DIR 的本地 wrangler 凭据导出(须已登录旧账号 fb8f4c…)…"
      (cd "$OLD_BOT_DIR" && npx wrangler d1 export "$OLD_DB" --remote --output "$DUMP_FILE" --skip-confirmation)
    else
      die "拿不到旧账号凭据:导出 WEBMERGE_OLD_CF_TOKEN=<旧账号API Token> 后重跑,或先 --skip-data。"
    fi
    [[ -s "$DUMP_FILE" ]] || die "导出文件为空:旧库导出失败。"

    info "转换(scripts/migrate-web-submissions.mjs)…"
    node scripts/migrate-web-submissions.mjs "$DUMP_FILE" "$IMPORT_FILE"

    info "导入本站 D1(事务,新表)…"
    pnpm exec wrangler d1 execute DB --remote --file "$IMPORT_FILE"

    info "留档:转换产物复制到 /tmp 之外由你自行保管;旧库 dump = $DUMP_FILE"
    ok "历史数据迁移完成。"
  fi
fi

# ---------------------------------------------------------------------------
# 4. 部署本站 Worker
# ---------------------------------------------------------------------------

stage "4/7 部署本站 Worker(build:admin + wrangler deploy)"
pnpm deploy
ok "Worker 已部署:$MAIN_ORIGIN"

# ---------------------------------------------------------------------------
# 5. 部署 cn-relay
# ---------------------------------------------------------------------------

if [[ $SKIP_RELAY -eq 1 ]]; then
  warn "--skip-relay:跳过中继部署。"
else
  stage "5/7 部署 cn-relay(必须在 Worker 之后:新路由把 /api/submit 落回主站)"
  if command -v vercel >/dev/null 2>&1; then
    (cd cn-relay && vercel deploy --prod --yes)
    ok "中继已部署:$RELAY_ORIGIN"
  else
    warn "本机没有 vercel CLI —— 手动部署:Vercel 项目(Root Directory = cn-relay)重新 Deploy。"
    warn "手动部署完再重跑本脚本 --verify-only 验证。"
  fi
fi

# ---------------------------------------------------------------------------
# 6. 旧附件只读 token(可选)
# ---------------------------------------------------------------------------

if [[ $SKIP_SECRET -eq 1 ]]; then
  warn "--skip-secret:跳过 SUBMISSION_BOT_LEGACY_TOKEN。旧投稿附件预览将显示「读取通道未启用」。"
else
  stage "6/7 配置 SUBMISSION_BOT_LEGACY_TOKEN(只读旧投稿附件;回车跳过)"
  read -r -s -p "粘贴旧机器人 BOT_TOKEN(留空跳过): " token
  echo
  if [[ -n "$token" ]]; then
    printf '%s' "$token" | pnpm exec wrangler secret put SUBMISSION_BOT_LEGACY_TOKEN
    ok "secret 已写入。"
  else
    warn "未配置;之后随时可:wrangler secret put SUBMISSION_BOT_LEGACY_TOKEN"
  fi
fi

# ---------------------------------------------------------------------------
# 7. 线上验证
# ---------------------------------------------------------------------------

stage "7/7 线上验证"
probe() {
  local label="$1" url="$2"
  local body
  body="$(curl -fsS --max-time 20 "$url" 2>/dev/null || true)"
  if [[ "$body" == *'"ok":true'* && "$body" == *'"form"'* ]]; then
    ok "$label /api/submit/form → ok"
  else
    warn "$label /api/submit/form 异常(返回头 200 但内容不含 form?)—— 手动打开 $url 检查"
  fi
}
probe "主站 " "$MAIN_ORIGIN/api/submit/form"
probe "中继 " "$RELAY_ORIGIN/api/submit/form"

cat <<'CHECKLIST'

✅ 自动验证完成。剩余人工清单(docs/ops/WEB_SUBMISSIONS_MERGE.md 第 5 步):
  [ ] 投稿中心 →「⚡ 免登录直投」:表单加载、验证题、提交拿到编号
  [ ] 「我的投稿」:新投稿 + 迁移来的旧投稿都在
  [ ] 管理后台 →「网页投稿」:列表/详情/通过/驳回(收件箱能看到结果)
  [ ] 旧投稿附件预览(若配了 legacy token)
观察一周后按手册第 6 步退役旧 Worker(deleteWebhook → 删 Worker → 删旧 D1)。
CHECKLIST
ok "部署流程结束。"

#!/usr/bin/env bash
# Linux/macOS: one-command PDF -> importable survey.json helper.
set -euo pipefail

task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_venv="$task_root/.pdf-tools-venv"
task_python="${PYTHON:-python3}"

if ! command -v "$task_python" >/dev/null 2>&1; then
  echo "未找到 Python 3。请先安装 Python 3 后重试。" >&2
  exit 1
fi

if [ ! -x "$task_venv/bin/python" ]; then
  echo "首次使用：正在创建 PDF 转换环境……"
  "$task_python" -m venv "$task_venv"
fi

if ! "$task_venv/bin/python" -c "import pymupdf" >/dev/null 2>&1; then
  echo "首次使用：正在安装 PDF 识别组件……"
  "$task_venv/bin/python" -m pip install --disable-pip-version-check pymupdf
fi

"$task_venv/bin/python" "$task_root/scripts/forms_pdf_to_survey.py" "$@"

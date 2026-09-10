import os
import re

# For each file, we need to:
# 1. Add `const { confirm, toast } = useDialogs();` inside the main component
# 2. Replace window.confirm(...) with await confirm({ message: ... })
# 3. Replace window.alert(...) with toast({ message: ..., variant: "error" })

files = {
    "admin/src/routes/ResponseDetailPage.tsx": {
        "component_var": "const { id, responseId } = useParams",
        "confirm": [
            ("window.confirm(confirmText)", "confirm({ message: confirmText, variant: \"danger\" })"),
        ],
    },
    "admin/src/routes/ResponsesPage.tsx": {
        "component_var": "const { id } = useParams",
        "confirm": [
            ('"把该问卷全部答卷的汇总表（CSV）发送到报告归档频道？"', '"把该问卷全部答卷的汇总表（CSV）发送到报告归档频道？"'),
        ],
        "confirm_template": "confirm({ message: __MSG__ })",
    },
    "admin/src/routes/SurveyDetailPage.tsx": {
        "component_var": "const { id } = useParams",
        "confirm": [
            ("window.confirm(confirmText)", "confirm({ message: confirmText, variant: \"danger\" })"),
        ],
    },
    "admin/src/routes/TemplatesPage.tsx": {
        "component_var": "const [selectedId, setSelectedId] = useState",
        "confirm": [
            ('window.confirm(`确定删除自定义模板「${id}」？`)', 'confirm({ message: `确定删除自定义模板「${id}」？`, variant: "danger" })'),
        ],
    },
    "admin/src/routes/UsersPage.tsx": {
        "component_var": "const [selected, setSelected] = useState",
        "confirm": [
            ("!window.confirm(`确定封禁 ${displayName(detail.user)}？封禁后该用户将无法使用机器人，且进行中的答卷会被取消。`)", '!(await confirm({ message: `确定封禁 ${displayName(detail.user)}？封禁后该用户将无法使用机器人，且进行中的答卷会被取消。`, variant: "danger" }))'),
        ],
    },
    "admin/src/routes/VersionsPage.tsx": {
        "component_var": "const { id } = useParams",
        "confirm": [
            ('window.confirm(`确定从版本 ${version} 恢复为新草稿？原问卷不会被修改。`)', 'confirm({ message: `确定从版本 ${version} 恢复为新草稿？原问卷不会被修改。` })'),
        ],
    },
    "admin/src/routes/SettingsPage.tsx": {
        "component_var": "const { data, error, retry } = useApi",
        "alert": [
            ('window.alert("创建失败，请重试")', 'toast({ message: "创建失败，请重试", variant: "error" })'),
            ('window.alert(err instanceof Error ? err.message : "创建失败")', 'toast({ message: err instanceof Error ? err.message : "创建失败", variant: "error" })'),
        ],
    },
    "admin/src/routes/ProfileGalleryPage.tsx": {
        "component_var": "const { id, responseId } = useParams",
        "alert": [
            ('window.alert(err instanceof Error ? err.message : "操作失败")', 'toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" })'),
            ('window.alert(err instanceof Error ? err.message : "封面设置失败")', 'toast({ message: err instanceof Error ? err.message : "封面设置失败", variant: "error" })'),
        ],
    },
    "admin/src/routes/PlazaPostsPage.tsx": {
        "component_var": "const [posts, setPosts] = useState",
        "alert": [
            ('window.alert(error instanceof Error ? error.message : "操作失败")', 'toast({ message: error instanceof Error ? error.message : "操作失败", variant: "error" })'),
        ],
    },
    "admin/src/routes/TaskPacksPage.tsx": {
        "component_var": "const { data, error, retry } = useApi",
        "confirm": [
            ('window.confirm(`确定删除任务包「${pack.name}」吗？历史挑战记录不受影响。`)', 'confirm({ message: `确定删除任务包「${pack.name}」吗？历史挑战记录不受影响。`, variant: "danger" })'),
        ],
        "alert": [
            ('window.alert(err instanceof Error ? err.message : "删除失败")', 'toast({ message: err instanceof Error ? err.message : "删除失败", variant: "error" })'),
            ('window.alert(err instanceof Error ? err.message : "操作失败")', 'toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" })'),
        ],
    },
    "admin/src/survey/SurveyApp.tsx": {
        "component_var": "const surveyId = useMemo",
        "alert": [
            ('window.alert(error instanceof Error ? error.message : "上传失败")', 'toast({ message: error instanceof Error ? error.message : "上传失败", variant: "error" })'),
        ],
    },
    "admin/src/survey/TrialScreen.tsx": {
        "component_var": "const { data: me, error: meError } = useApi",
        "confirm": [
            ('window.confirm("确定要放弃这一局吗？进度会保留在历史记录里。")', 'confirm({ message: "确定要放弃这一局吗？进度会保留在历史记录里。", variant: "danger" })'),
            ('window.confirm("使用 1 个护盾提前结算本局？将以当前成绩记为通关。")', 'confirm({ message: "使用 1 个护盾提前结算本局？将以当前成绩记为通关。" })'),
        ],
    },
}

cwd = os.getcwd()

for rel, cfg in files.items():
    path = os.path.join(cwd, rel)
    if not os.path.exists(path):
        print(f"SKIP: {rel}")
        continue
    with open(path, "r") as f:
        content = f.read()

    # Check if already has useDialogs call
    if "useDialogs()" not in content:
        # Need to find the component function and add the hook
        # We search for the component_var pattern and add after it
        anchor = cfg["component_var"]
        if anchor not in content:
            print(f"  WARN anchor not found in {rel}: {anchor}")
            continue
        
        # Find line with anchor and add after
        idx = content.find(anchor)
        line_start = content.rfind("\n", 0, idx) + 1
        line_end = content.find("\n", idx)
        if line_end == -1:
            line_end = len(content)
        
        # Count leading spaces
        line = content[line_start:line_end]
        indent = len(line) - len(line.lstrip(" "))
        pad = " " * indent
        
        # Add dialogs hook after the anchor line
        has_confirm = cfg.get("confirm") is not None and len(cfg.get("confirm", [])) > 0
        has_alert = cfg.get("alert") is not None and len(cfg.get("alert", [])) > 0
        hook_vars = []
        if has_confirm:
            hook_vars.append("confirm")
        if has_alert:
            hook_vars.append("toast")
        hook_line = f"{pad}const {{ {', '.join(hook_vars)} }} = useDialogs();\n"
        
        content = content[:line_end] + "\n" + hook_line + content[line_end:]
        print(f"  +hook in {rel}")

    # Now do replacements
    # Handle confirm calls
    if "confirm" in cfg:
        for old, new in cfg["confirm"]:
            if old not in content:
                print(f"  WARN confirm not found in {rel}: {old[:60]}")
                continue
            # window.confirm(...) returns boolean, new confirm() returns Promise<boolean>
            # Need to add await
            if old.startswith("window.confirm("):
                replacement = f"await {new.replace('confirm(', 'confirm(')}"
                content = content.replace(old, f"await {new}")
            else:
                # Cases like !window.confirm(...)
                content = content.replace(old, new)
            print(f"  +confirm replace in {rel}")

    # Handle alert calls
    if "alert" in cfg:
        for old, new in cfg["alert"]:
            if old not in content:
                print(f"  WARN alert not found in {rel}: {old[:60]}")
                continue
            content = content.replace(old, new)
            print(f"  +alert replace in {rel}")

    with open(path, "w") as f:
        f.write(content)
    print(f"OK: {rel}")

print("\nDone! Let's also handle ResponsesPage and VersionsPage special cases")

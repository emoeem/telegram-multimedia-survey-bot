import os

cwd = os.getcwd()

# (file, old_exact, new_exact)
simple_replaces = [
    # EditorPage publish confirm (中文引号)
    ("admin/src/routes/EditorPage.tsx",
     "    if (!window.confirm(`确定发布\u201c${editor.surveyMeta.title}\u201d？发布后需复制为新草稿才能继续编辑。`)) return;",
     "    if (!(await confirm({ message: `确定发布\u201c${editor.surveyMeta.title}\u201d？发布后需复制为新草稿才能继续编辑。` }))) return;"),

    # ResponsesPage
    ("admin/src/routes/ResponsesPage.tsx",
     '    if (!window.confirm("把该问卷全部答卷的汇总表（CSV）发送到报告归档频道？")) return;',
     '    if (!(await confirm({ message: "把该问卷全部答卷的汇总表（CSV）发送到报告归档频道？" }))) return;'),

    # TemplatesPage
    ("admin/src/routes/TemplatesPage.tsx",
     '    if (!window.confirm(`确定删除自定义模板「${id}」？`)) return;',
     '    if (!(await confirm({ message: `确定删除自定义模板「${id}」？`, variant: "danger" }))) return;'),

    # ProfileGalleryPage 2 alerts
    ("admin/src/routes/ProfileGalleryPage.tsx",
     '      window.alert(err instanceof Error ? err.message : "操作失败");',
     '      toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" });'),
    ("admin/src/routes/ProfileGalleryPage.tsx",
     '      window.alert(err instanceof Error ? err.message : "封面设置失败");',
     '      toast({ message: err instanceof Error ? err.message : "封面设置失败", variant: "error" });'),

    # PlazaPostsPage
    ("admin/src/routes/PlazaPostsPage.tsx",
     '      window.alert(error instanceof Error ? error.message : "操作失败");',
     '      toast({ message: error instanceof Error ? error.message : "操作失败", variant: "error" });'),

    # TrialScreen 3 confirms
    ("admin/src/survey/TrialScreen.tsx",
     '    if (!window.confirm("确定要放弃这一局吗？进度会保留在历史记录里。")) return;',
     '    if (!(await confirm({ message: "确定要放弃这一局吗？进度会保留在历史记录里。", variant: "danger" }))) return;'),
    ("admin/src/survey/TrialScreen.tsx",
     '    if (action === "abandon" && !window.confirm("确定要放弃这一局吗？进度会保留在历史记录里。")) return;',
     '    if (action === "abandon" && !(await confirm({ message: "确定要放弃这一局吗？进度会保留在历史记录里。", variant: "danger" }))) return;'),
    ("admin/src/survey/TrialScreen.tsx",
     '    if (action === "shield_exit" && !window.confirm("使用 1 个护盾提前结算本局？将以当前成绩记为通关。")) return;',
     '    if (action === "shield_exit" && !(await confirm({ message: "使用 1 个护盾提前结算本局？将以当前成绩记为通关。" }))) return;'),
]

for rel, old, new in simple_replaces:
    path = os.path.join(cwd, rel)
    with open(path, "r") as f:
        content = f.read()
    if old not in content:
        print(f"WARN not found in {rel}")
        continue
    content = content.replace(old, new)
    with open(path, "w") as f:
        f.write(content)
    print(f"OK: {rel}")

# Now we still need to add useDialogs() hook to TemplatesPage, ProfileGalleryPage, PlazaPostsPage, TrialScreen
# because script failed to find their anchor patterns
print("\n--- Adding hooks to remaining files ---")

# TemplatesPage: find main function
path = os.path.join(cwd, "admin/src/routes/TemplatesPage.tsx")
with open(path, "r") as f:
    content = f.read()
if "useDialogs()" not in content:
    # Find first useState after the DnD imports
    idx = content.find("const [templates, setTemplates]")
    if idx == -1:
        print("  TemplatesPage: anchor not found, searching...")
        # Try finding function declaration
        for line in content.split("\n"):
            if "export function Templates" in line or "function Templates" in line:
                print(f"  Found: {line}")
                break
    else:
        line_start = content.rfind("\n", 0, idx) + 1
        line_end = content.find("\n", idx)
        content = content[:line_end+1] + "  const { confirm } = useDialogs();\n" + content[line_end+1:]
        with open(path, "w") as f:
            f.write(content)
        print("  TemplatesPage: hook added")

# ProfileGalleryPage
path = os.path.join(cwd, "admin/src/routes/ProfileGalleryPage.tsx")
with open(path, "r") as f:
    content = f.read()
if "useDialogs()" not in content:
    idx = content.find("const { data, error, retry } = useApi")
    if idx == -1:
        print("  ProfileGalleryPage: checking...")
        # Search for useApi
        for line in content.split("\n"):
            if "useApi" in line and "const" in line:
                print(f"  Found: {line.strip()}")
                break
    else:
        line_end = content.find("\n", idx)
        content = content[:line_end+1] + "  const { toast } = useDialogs();\n" + content[line_end+1:]
        with open(path, "w") as f:
            f.write(content)
        print("  ProfileGalleryPage: hook added")

# PlazaPostsPage
path = os.path.join(cwd, "admin/src/routes/PlazaPostsPage.tsx")
with open(path, "r") as f:
    content = f.read()
if "useDialogs()" not in content:
    idx = content.find("const { data, error, retry } = useApi")
    if idx == -1:
        print("  PlazaPostsPage: checking...")
    else:
        line_end = content.find("\n", idx)
        content = content[:line_end+1] + "  const { toast } = useDialogs();\n" + content[line_end+1:]
        with open(path, "w") as f:
            f.write(content)
        print("  PlazaPostsPage: hook added")

# TrialScreen
path = os.path.join(cwd, "admin/src/survey/TrialScreen.tsx")
with open(path, "r") as f:
    content = f.read()
if "useDialogs()" not in content:
    # TrialScreen is a big component, let's find a good anchor
    idx = content.find("const { data: me, error: meError } = useApi")
    if idx == -1:
        print("  TrialScreen: checking for useApi pattern...")
        for line in content.split("\n"):
            if "const { data" in line and "useApi" in line:
                print(f"  Found: {line.strip()}")
                break
    else:
        line_end = content.find("\n", idx)
        content = content[:line_end+1] + "  const { confirm, toast } = useDialogs();\n" + content[line_end+1:]
        with open(path, "w") as f:
            f.write(content)
        print("  TrialScreen: hook added")

print("\nAll done!")

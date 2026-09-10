import os

files_to_update = [
    ("admin/src/routes/ResponseDetailPage.tsx", 'import { ErrorPanel, SkeletonPanel } from "../components/ui";', 'import { ErrorPanel, SkeletonPanel } from "../components/ui";\nimport { useDialogs } from "../components/Dialogs";'),
    ("admin/src/routes/ResponsesPage.tsx", 'import { formatDateTime } from "../format";', 'import { useDialogs } from "../components/Dialogs";\nimport { formatDateTime } from "../format";'),
    ("admin/src/routes/SurveyDetailPage.tsx", 'import { formatDateTime } from "../format";', 'import { useDialogs } from "../components/Dialogs";\nimport { formatDateTime } from "../format";'),
    ("admin/src/routes/TemplatesPage.tsx", 'import { useEffect, useState } from "react";', 'import { useEffect, useState } from "react";\nimport { useDialogs } from "../components/Dialogs";'),
    ("admin/src/routes/UsersPage.tsx", 'import { formatDateTime } from "../format";', 'import { useDialogs } from "../components/Dialogs";\nimport { formatDateTime } from "../format";'),
    ("admin/src/routes/VersionsPage.tsx", 'import { useApi } from "../hooks";', 'import { useDialogs } from "../components/Dialogs";\nimport { useApi } from "../hooks";'),
    ("admin/src/routes/SettingsPage.tsx", 'import { useEffect, useState } from "react";', 'import { useEffect, useState } from "react";\nimport { useDialogs } from "../components/Dialogs";'),
    ("admin/src/routes/ProfileGalleryPage.tsx", 'import { formatDateTime } from "../format";', 'import { useDialogs } from "../components/Dialogs";\nimport { formatDateTime } from "../format";'),
    ("admin/src/routes/PlazaPostsPage.tsx", 'import { useEffect, useState } from "react";', 'import { useEffect, useState } from "react";\nimport { useDialogs } from "../components/Dialogs";'),
    ("admin/src/routes/TaskPacksPage.tsx", 'import { formatDateTime } from "../format";', 'import { useDialogs } from "../components/Dialogs";\nimport { formatDateTime } from "../format";'),
    ("admin/src/survey/SurveyApp.tsx", 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";', 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";\nimport { useDialogs } from "../components/Dialogs";'),
    ("admin/src/survey/TrialScreen.tsx", 'import { vibrateSuccess, vibrateFail, vibrateLight, notify, requestNotificationPermission } from "./haptics";', 'import { vibrateSuccess, vibrateFail, vibrateLight, notify, requestNotificationPermission } from "./haptics";\nimport { useDialogs } from "../components/Dialogs";'),
]

cwd = os.getcwd()
for rel, old, new in files_to_update:
    path = os.path.join(cwd, rel)
    if not os.path.exists(path):
        print(f"SKIP not found: {rel}")
        continue
    with open(path, "r") as f:
        content = f.read()
    if old not in content:
        print(f"WARN pattern not found: {rel}")
        continue
    content = content.replace(old, new)
    with open(path, "w") as f:
        f.write(content)
    print(f"OK import: {rel}")

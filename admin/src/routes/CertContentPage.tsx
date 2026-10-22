import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Upload, Download, Save, RotateCcw } from "lucide-react";
import { api, apiSend } from "../api";
import { SkeletonPanel } from "../components/ui";

/**
 * 认证卡内容管理：维护 /cert 生成器使用的主题包（存 system_settings 单键 JSON）。
 * 页面保存后，生成器下次打开即使用这里的内容；删除则回退到代码内置默认。
 */

interface CertRank {
  min: number;
  max: number;
  name: string;
}

interface CertGroup {
  name: string;
  emoji: string;
  tags: string[];
}

interface CertTheme {
  id: string;
  name: string;
  cardLabel: string;
  issuer: string;
  subtitle: string;
  sealText: string;
  palette: {
    primary: string;
    primary2: string;
    accent: string;
    ink: string;
    muted: string;
    paper: string;
  };
  tags: string[];
  groups: CertGroup[];
  ranks: CertRank[];
}

interface CertContentPack {
  version: 1;
  themes: CertTheme[];
}

const PALETTE_FIELDS: Array<{ key: keyof CertTheme["palette"]; label: string; fallback: string }> = [
  { key: "primary", label: "主色", fallback: "#1e3a8a" },
  { key: "primary2", label: "主色渐变", fallback: "#2563eb" },
  { key: "accent", label: "强调色", fallback: "#f59e0b" },
  { key: "ink", label: "正文色", fallback: "#0f172a" },
  { key: "muted", label: "次要文字", fallback: "#64748b" },
  { key: "paper", label: "卡片底色", fallback: "#f7f9fc" },
];

const newUid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

function blankTheme(): CertTheme {
  const uid = newUid();
  return {
    id: `theme-${uid}`,
    name: "新主题",
    cardLabel: "认证卡",
    issuer: "趣味认证中心",
    subtitle: "FUN CERTIFICATE",
    sealText: "趣味认证专用章",
    palette: {
      primary: "#1e3a8a",
      primary2: "#2563eb",
      accent: "#f59e0b",
      ink: "#0f172a",
      muted: "#64748b",
      paper: "#f7f9fc",
    },
    tags: ["示例标签一", "示例标签二", "示例标签三"],
    groups: [{ name: "日常", emoji: "🏷️", tags: ["示例标签一", "示例标签二", "示例标签三"] }],
    ranks: [
      { min: 0, max: 33, name: "青铜" },
      { min: 34, max: 66, name: "白银" },
      { min: 67, max: 100, name: "王者" },
    ],
  };
}

const parseTags = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((x) => String(x ?? "").trim()).filter(Boolean) : [];

/** 旧格式只有扁平 tags：包成一个「全部」分组，编辑器里可以再拆。 */
function normalizeGroups(raw: unknown, tags: string[]): CertGroup[] {
  if (Array.isArray(raw)) {
    const groups = raw
      .map((g) => {
        const row = (g ?? {}) as Record<string, unknown>;
        return {
          name: String(row.name ?? "").trim() || "标签",
          emoji: String(row.emoji ?? "").trim() || "🏷️",
          tags: parseTags(row.tags),
        };
      })
      .filter((g) => g.tags.length);
    if (groups.length) return groups;
  }
  return tags.length ? [{ name: "全部", emoji: "🏷️", tags }] : [];
}

function normalizeTheme(raw: unknown): CertTheme {
  const t = blankTheme();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    return s || fallback;
  };
  const pal = (r.palette ?? {}) as Record<string, unknown>;
  const color = (v: unknown, fallback: string) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? "")) ? String(v) : fallback);
  return {
    id: str(r.id, t.id),
    name: str(r.name, t.name),
    cardLabel: str(r.cardLabel, t.cardLabel),
    issuer: str(r.issuer, t.issuer),
    subtitle: str(r.subtitle, t.subtitle),
    sealText: str(r.sealText, t.sealText),
    palette: {
      primary: color(pal.primary, t.palette.primary),
      primary2: color(pal.primary2, t.palette.primary2),
      accent: color(pal.accent, t.palette.accent),
      ink: color(pal.ink, t.palette.ink),
      muted: color(pal.muted, t.palette.muted),
      paper: color(pal.paper, t.palette.paper),
    },
    tags: parseTags(r.tags).length ? parseTags(r.tags) : t.tags,
    groups: normalizeGroups(r.groups, parseTags(r.tags).length ? parseTags(r.tags) : t.tags),
    ranks: Array.isArray(r.ranks)
      ? r.ranks
          .map((row) => {
            const item = (row ?? {}) as Record<string, unknown>;
            return {
              min: Math.max(0, Math.min(100, Math.round(Number(item.min ?? 0)) || 0)),
              max: Math.max(0, Math.min(100, Math.round(Number(item.max ?? 100)) || 0)),
              name: String(item.name ?? "").trim(),
            };
          })
          .filter((row) => row.name)
      : t.ranks,
  };
}

export function CertContentPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [themes, setThemes] = useState<CertTheme[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [serverHasPack, setServerHasPack] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ pack: CertContentPack | null }>("/api/admin/cert-content");
      if (data.pack && Array.isArray(data.pack.themes) && data.pack.themes.length) {
        const list = data.pack.themes.map(normalizeTheme);
        setThemes(list);
        setActiveId(list[0]?.id ?? "");
        setServerHasPack(true);
      } else {
        const starter = blankTheme();
        setThemes([starter]);
        setActiveId(starter.id);
        setServerHasPack(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => themes.find((t) => t.id === activeId) ?? null, [themes, activeId]);

  const patchActive = (patch: Partial<CertTheme>) => {
    if (!active) return;
    setThemes((list) => list.map((t) => (t.id === active.id ? { ...t, ...patch } : t)));
  };

  const patchPalette = (key: keyof CertTheme["palette"], value: string) => {
    if (!active) return;
    setThemes((list) => list.map((t) => (t.id === active.id ? { ...t, palette: { ...t.palette, [key]: value } } : t)));
  };

  const save = async () => {
    if (!themes.length) {
      setError("至少需要一套主题");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiSend("PUT", "/api/admin/cert-content", {
        version: 1,
        themes: themes.map((t) => ({ ...t, tags: t.groups.flatMap((g) => g.tags) })),
      } as unknown as Record<string, unknown>);
      setServerHasPack(true);
      setNotice("已保存，生成器页面下次打开即生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("确定删除服务器上的内容包？/cert 页面将回退到代码内置的默认主题。")) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiSend("DELETE", "/api/admin/cert-content");
      setNotice("已恢复内置默认。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSaving(false);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ version: 1, themes }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cert-content-pack.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const rawThemes =
        parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).themes)
          ? ((parsed as Record<string, unknown>).themes as unknown[])
          : Array.isArray(parsed)
            ? (parsed as unknown[])
            : null;
      if (!rawThemes?.length) throw new Error("文件里没有主题");
      const list = rawThemes.map(normalizeTheme);
      setThemes(list);
      setActiveId(list[0]?.id ?? "");
      setNotice("已导入到编辑器，检查无误后记得点「保存」。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    }
  };

  if (loading) return <SkeletonPanel />;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">认证卡内容</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            管理 <code>/cert</code> 趣味认证卡生成器的主题包。
            {serverHasPack ? "当前使用下方自定义内容。" : "当前线上仍是代码内置默认主题，保存后覆盖。"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="btn btn-ghost">
            <Upload size={15} /> 导入 JSON
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importJson(file);
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" className="btn btn-ghost" onClick={exportJson}>
            <Download size={15} /> 导出 JSON
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void reset()} disabled={saving}>
            <RotateCcw size={15} /> 恢复内置默认
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            <Save size={15} /> 保存
          </button>
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">{error}</p>}
      {notice && <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}

      <div className="mt-5 grid gap-4 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-xl border border-[var(--color-border)] p-3">
          <ul className="flex flex-col gap-1">
            {themes.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                    t.id === activeId ? "bg-primary/10 font-semibold" : "hover:bg-base-200"
                  }`}
                  onClick={() => setActiveId(t.id)}
                >
                  <span className="size-3 rounded" style={{ background: t.palette.accent }} />
                  <span className="flex-1 truncate">{t.name}</span>
                  {themes.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`删除 ${t.name}`}
                      className="text-[var(--color-muted)] hover:text-error"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!window.confirm(`删除主题「${t.name}」？（保存后生效）`)) return;
                        const next = themes.filter((x) => x.id !== t.id);
                        setThemes(next);
                        if (activeId === t.id) setActiveId(next[0]?.id ?? "");
                      }}
                    >
                      <Trash2 size={14} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-2 w-full"
            onClick={() => {
              const t = blankTheme();
              setThemes((list) => [...list, t]);
              setActiveId(t.id);
            }}
          >
            <Plus size={14} /> 新增主题
          </button>
        </aside>

        {active ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">主题 ID（唯一，小写字母/数字/连字符）</span>
                <input
                  className="input input-sm"
                  value={active.id}
                  onChange={(e) => patchActive({ id: e.target.value.trim() })}
                />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">主题名称</span>
                <input className="input input-sm" value={active.name} onChange={(e) => patchActive({ name: e.target.value })} />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">发证机构</span>
                <input className="input input-sm" value={active.issuer} onChange={(e) => patchActive({ issuer: e.target.value })} />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">页眉英文副标题</span>
                <input
                  className="input input-sm"
                  value={active.subtitle}
                  onChange={(e) => patchActive({ subtitle: e.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">徽标文字（卡片右上角）</span>
                <input
                  className="input input-sm"
                  value={active.cardLabel}
                  onChange={(e) => patchActive({ cardLabel: e.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">印章环文字</span>
                <input
                  className="input input-sm"
                  value={active.sealText}
                  onChange={(e) => patchActive({ sealText: e.target.value })}
                />
              </label>
            </div>

            <div>
              <p className="mb-2 text-xs text-[var(--color-muted)]">配色</p>
              <div className="flex flex-wrap gap-3">
                {PALETTE_FIELDS.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-xs">
                    <input
                      type="color"
                      className="size-8 cursor-pointer rounded border border-[var(--color-border)]"
                      value={active.palette[f.key]}
                      onChange={(e) => patchPalette(f.key, e.target.value)}
                    />
                    {f.label}
                    <code className="text-[10px] text-[var(--color-muted)]">{active.palette[f.key]}</code>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-[var(--color-muted)]">
                  分组标签库（用户勾选后计入强度，可自行增删改名）
                </p>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (!active) return;
                    patchActive({ groups: [...active.groups, { name: "新分组", emoji: "🏷️", tags: ["新标签"] }] });
                  }}
                >
                  <Plus size={14} /> 增加分组
                </button>
              </div>
              <div className="flex flex-col gap-3">
                {active.groups.map((group, gIndex) => (
                  <div key={gIndex} className="rounded-xl border border-[var(--color-border)] p-3">
                    <div className="flex items-center gap-2">
                      <input
                        className="input input-sm w-16 text-center"
                        value={group.emoji}
                        placeholder="🏷️"
                        onChange={(e) => {
                          const emoji = e.target.value;
                          patchActive({
                            groups: active.groups.map((g, i) => (i === gIndex ? { ...g, emoji } : g)),
                          });
                        }}
                      />
                      <input
                        className="input input-sm w-36"
                        value={group.name}
                        placeholder="分组名"
                        onChange={(e) => {
                          const name = e.target.value;
                          patchActive({
                            groups: active.groups.map((g, i) => (i === gIndex ? { ...g, name } : g)),
                          });
                        }}
                      />
                      <span className="text-xs text-[var(--color-muted)]">{group.tags.length} 个标签</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm ml-auto"
                        aria-label="删除该分组"
                        onClick={() => {
                          patchActive({ groups: active.groups.filter((_, i) => i !== gIndex) });
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <textarea
                      className="textarea mt-2 min-h-20 font-mono text-sm"
                      value={group.tags.join("\n")}
                      onChange={(e) => {
                        const tags = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                        patchActive({
                          groups: active.groups.map((g, i) => (i === gIndex ? { ...g, tags } : g)),
                        });
                      }}
                    />
                  </div>
                ))}
                {!active.groups.length && (
                  <p className="text-sm text-[var(--color-muted)]">还没有分组，点右上角「增加分组」。</p>
                )}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs text-[var(--color-muted)]">等级称号（按百分比区间命中）</p>
              <div className="flex flex-col gap-2">
                {active.ranks.map((rank, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="input input-sm w-20"
                      value={rank.min}
                      onChange={(e) => {
                        const min = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                        patchActive({
                          ranks: active.ranks.map((r, i) => (i === index ? { ...r, min } : r)),
                        });
                      }}
                    />
                    <span className="text-xs text-[var(--color-muted)]">–</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="input input-sm w-20"
                      value={rank.max}
                      onChange={(e) => {
                        const max = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                        patchActive({
                          ranks: active.ranks.map((r, i) => (i === index ? { ...r, max } : r)),
                        });
                      }}
                    />
                    <input
                      className="input input-sm flex-1"
                      value={rank.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        patchActive({
                          ranks: active.ranks.map((r, i) => (i === index ? { ...r, name } : r)),
                        });
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="删除该档位"
                      onClick={() => {
                        if (active.ranks.length <= 1) return;
                        patchActive({ ranks: active.ranks.filter((_, i) => i !== index) });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-2"
                onClick={() => {
                  const last = active.ranks[active.ranks.length - 1];
                  patchActive({
                    ranks: [...active.ranks, { min: Math.min(last?.max ?? 66, 99), max: 100, name: "新等级" }],
                  });
                }}
              >
                <Plus size={14} /> 增加一档
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">没有可选主题，点左侧「新增主题」。</p>
        )}
      </div>
    </section>
  );
}

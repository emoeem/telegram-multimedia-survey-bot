import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker } from "react-router";
import { Plus, Trash2, Upload, Download, Save, RotateCcw } from "lucide-react";
import { api, apiSend, ApiError, fetchAdminTaskPacks } from "../api";
import { useDialogs } from "../components/Dialogs";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import {
  blankTheme,
  normalizeTheme,
  rankScaleHi,
  themePayload,
  validateThemes,
  type CertContentPack,
  type CertTheme,
} from "../cert-content-model";

/**
 * 认证卡内容管理：维护 /cert 生成器使用的主题包（存 system_settings 单键 JSON）。
 * 页面保存后，生成器下次打开即使用这里的内容；删除则回退到代码内置默认。
 */

/** 编辑器里的配色槽位；类型与校验都在 cert-content-model.ts。 */
const PALETTE_FIELDS: Array<{ key: keyof CertTheme["palette"]; label: string; fallback: string }> = [
  { key: "primary", label: "主色", fallback: "#1e3a8a" },
  { key: "primary2", label: "主色渐变", fallback: "#2563eb" },
  { key: "accent", label: "强调色", fallback: "#f59e0b" },
  { key: "ink", label: "正文色", fallback: "#0f172a" },
  { key: "muted", label: "次要文字", fallback: "#64748b" },
  { key: "paper", label: "卡片底色", fallback: "#f7f9fc" },
];

/** `#abc` / `#aabbcc` / `#aabbccdd`, with or without the leading `#`. */
const HEX_INPUT = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function normalizeHexInput(input: string): string | null {
  const match = HEX_INPUT.exec(input.trim());
  if (!match) return null;
  const digits = match[1]!;
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits;
  return `#${full.toLowerCase()}`;
}

/**
 * HEX / HEX8 field beside a native swatch.
 *
 * `<input type="color">` is the only picker available without adding a
 * dependency, but its value is restricted to `#rrggbb`: feed it
 * `#ffffff80` and the browser resets it to `#000000`, silently dropping the
 * admin's colour. So the alpha suffix is split off before handing the value
 * over and re-attached when a colour is picked from the swatch.
 *
 * The text field keeps its own draft while typing (`#f59` is a valid prefix
 * on the way to `#f59e0b`), commits only once the value parses, and reverts
 * to the stored value on blur so a half-typed string cannot reach the pack.
 */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const parsed = normalizeHexInput(draft);
  const invalid = draft.trim() !== "" && parsed === null;
  const swatch = /^#[0-9a-fA-F]{6,8}$/.test(value) ? value.slice(0, 7) : "#000000";
  const alpha = value.length === 9 ? value.slice(7) : "";

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className="color-well"
        value={swatch}
        onChange={(event) => onChange(event.target.value + alpha)}
        aria-label={`${label}取色器`}
      />
      <input
        className={`input input-sm w-full min-w-0 font-mono ${invalid ? "input-invalid" : ""}`}
        value={draft}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${label}色值，支持 HEX 或 HEX8`}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = normalizeHexInput(event.target.value);
          if (next) onChange(next);
        }}
        onBlur={() => setDraft(parsed ?? value)}
      />
      <span className="w-14 shrink-0 text-xs text-[var(--color-muted)]">{label}</span>
    </div>
  );
}

export function CertContentPage() {
  const { confirm, alert, toast } = useDialogs();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [themes, setThemes] = useState<CertTheme[]>([]);
  /**
   * 选中项用**下标**，不是 id。
   *
   * 旧实现按 id 定位当前主题，于是「主题 ID」输入框只能敲进一个字符：改成新 id 后
   * `themes.find(t => t.id === activeId)` 当场落空，右侧整个表单被换成
   * 「没有可选主题」，输入框自己被卸载，这个字段实际上是不可编辑的。
   * 下标不受 id 变化影响；顺带解决「两套主题同 id 时改一个连带改另一个」。
   */
  const [activeIndex, setActiveIndex] = useState(0);
  const [serverHasPack, setServerHasPack] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 已保存内容的快照（JSON），用来判断脏状态。 */
  const [baseline, setBaseline] = useState<string | null>(null);

  const snapshot = useCallback((list: CertTheme[]) => JSON.stringify(list.map(themePayload)), []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ pack: CertContentPack | null }>("/api/admin/cert-content");
      const hasPack = Boolean(data.pack && Array.isArray(data.pack.themes) && data.pack.themes.length);
      const list = hasPack && data.pack ? data.pack.themes.map(normalizeTheme) : [blankTheme()];
      setThemes(list);
      setActiveIndex(0);
      setServerHasPack(hasPack);
      setBaseline(snapshot(list));
    } catch (err) {
      setLoadError(err instanceof Error ? err : new Error("加载失败"));
    } finally {
      setLoading(false);
    }
  }, [snapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = themes[activeIndex] ?? null;
  const dirty = baseline !== null && baseline !== snapshot(themes);
  const issues = useMemo(() => validateThemes(themes), [themes]);

  /** 当前主题自己的问题（行内提示用）。 */
  const activeIssues = useMemo(() => issues.filter((issue) => issue.themeIndex === activeIndex), [issues, activeIndex]);
  /** 主题 ID 是「改完即错」的字段：单独拿出来，标红 + 直接禁保存。 */
  const idIssue = activeIssues.find((issue) => issue.field === "id") ?? null;
  /** 页头列出「全局 + 当前主题」的问题，其它主题的问题切过去才显示，避免一次糊十几行。 */
  const visibleIssues = useMemo(() => {
    const global = issues.filter((issue) => issue.themeIndex === null);
    return [...global, ...activeIssues].slice(0, 6);
  }, [issues, activeIssues]);
  /** 区间上限：分值制 999，百分比制 100。 */
  const hi = active ? rankScaleHi(active) : 100;

  const patchActive = (patch: Partial<CertTheme>) => {
    setThemes((list) => list.map((t, index) => (index === activeIndex ? { ...t, ...patch } : t)));
  };

  const patchPalette = (key: keyof CertTheme["palette"], value: string) => {
    setThemes((list) =>
      list.map((t, index) => (index === activeIndex ? { ...t, palette: { ...t.palette, [key]: value } } : t)),
    );
  };

  const removeTheme = async (index: number) => {
    const target = themes[index];
    if (!target) return;
    const ok = await confirm({
      title: `删除主题「${target.name || target.id}」？`,
      message: "会从编辑器里移除这一套；点「保存」后才对线上生效。",
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    const next = themes.filter((_, i) => i !== index);
    setThemes(next);
    setActiveIndex((current) => Math.max(0, Math.min(current >= index ? current - 1 : current, next.length - 1)));
  };

  // 站内路由跳转拦截（useBlocker 只在 data router 下可用，本项目用的是 createBrowserRouter）。
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void (async () => {
      const ok = await confirm({
        title: "有未保存的修改",
        message: "认证卡内容还没保存，离开后这些修改会丢失。",
        confirmLabel: "离开",
        cancelLabel: "留下修改",
        variant: "danger",
      });
      if (ok) blocker.proceed();
      else blocker.reset();
    })();
  }, [blocker, confirm]);

  // useBlocker 只管站内跳转，刷新/关标签页要单独拦一次。
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const save = async () => {
    if (idIssue) {
      toast({ message: idIssue.message, variant: "error" });
      return;
    }
    const blocking = validateThemes(themes);
    if (blocking.length) {
      // 纯告知：没有可选的第二条路，用单键 alert。原来套 confirm 只能编一个
      // 「知道了」当假取消，两个按钮做的是同一件事。
      await alert({
        title: `无法保存（${blocking.length} 项问题）`,
        message: blocking.map((issue) => `• ${issue.message}`).join("\n"),
        buttonLabel: "返回修改",
        variant: "danger",
      });
      return;
    }
    setSaving(true);
    try {
      const payload = { version: 1, themes: themes.map(themePayload) } as unknown as Record<string, unknown>;
      await apiSend("PUT", "/api/admin/cert-content", payload);
      setServerHasPack(true);
      setBaseline(snapshot(themes));
      toast({ message: "已保存，生成器页面下次打开即生效。", variant: "success" });
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "保存失败", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({
      title: "恢复内置默认",
      message: "确定删除服务器上的内容包？/cert 页面将回退到代码内置的默认主题。",
      confirmLabel: "删除内容包",
      variant: "danger",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await apiSend("DELETE", "/api/admin/cert-content");
      toast({ message: "已恢复内置默认。", variant: "success" });
      await load();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const exportJson = () => {
    const payload = { version: 1, themes: themes.map(themePayload) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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
      setActiveIndex(0);
      toast({ message: `已导入 ${list.length} 套主题到编辑器，检查无误后点「保存」。`, variant: "success" });
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "导入失败", variant: "error" });
    }
  };

  if (loading) return <SkeletonPanel />;
  if (loadError) {
    return (
      <ErrorPanel
        error={loadError instanceof ApiError ? loadError : new ApiError(0, loadError.message)}
        onRetry={() => void load()}
      />
    );
  }

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
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={saving || Boolean(idIssue)}
            aria-describedby={idIssue ? "cert-issues" : undefined}
          >
            <Save size={15} /> 保存
          </button>
        </div>
      </div>

      {dirty ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <span className="size-1.5 rounded-full bg-[var(--app-warning)]" aria-hidden />
          有未保存的修改
        </p>
      ) : null}

      {issues.length ? (
        <div
          id="cert-issues"
          role="status"
          className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--app-danger)_35%,var(--surface))] bg-[color-mix(in_srgb,var(--app-danger)_8%,var(--surface))] px-3 py-2 text-sm text-[var(--app-danger)]"
        >
          <p className="font-semibold">{issues.length} 项需要修正，保存会被拦下</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {visibleIssues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
          {issues.length > visibleIssues.length ? (
            <p className="mt-1 text-xs opacity-80">这里只列全局问题与当前主题的问题，切到其它主题可看各自的。</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-surface border border-[var(--color-edge)] p-3">
          <ul className="flex flex-col gap-1">
            {themes.map((t, index) => (
              <li key={index} className="flex items-center gap-1">
                <button
                  type="button"
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ${
                    index === activeIndex ? "bg-primary/10 font-semibold" : "hover:bg-base-200"
                  }`}
                  onClick={() => setActiveIndex(index)}
                  aria-current={index === activeIndex ? "true" : undefined}
                >
                  <span className="size-3 shrink-0 rounded" style={{ background: t.palette.accent }} />
                  <span className="flex-1 truncate">{t.name}</span>
                </button>
                {themes.length > 1 ? (
                  <button
                    type="button"
                    aria-label={`删除主题 ${t.name || t.id}`}
                    className="btn btn-ghost btn-sm shrink-0"
                    onClick={() => void removeTheme(index)}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-2 w-full"
            onClick={() => {
              setThemes((list) => [...list, blankTheme()]);
              setActiveIndex(themes.length);
            }}
          >
            <Plus size={14} /> 新增主题
          </button>
        </aside>

        {active ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">
                  主题 ID（唯一，小写字母/数字/连字符）
                </span>
                <input
                  className={`input input-sm ${
                    idIssue ? "border-[color-mix(in_srgb,var(--app-danger)_60%,var(--control-border))]" : ""
                  }`}
                  value={active.id}
                  aria-invalid={idIssue ? true : undefined}
                  aria-describedby={idIssue ? "theme-id-error" : undefined}
                  onChange={(e) => patchActive({ id: e.target.value.trim() })}
                />
                {idIssue ? (
                  <span id="theme-id-error" className="mt-1 text-xs text-[var(--app-danger)]">
                    {idIssue.message}
                  </span>
                ) : null}
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">主题名称</span>
                <input
                  className="input input-sm"
                  value={active.name}
                  onChange={(e) => patchActive({ name: e.target.value })}
                />
              </label>
              <label className="form-control">
                <span className="mb-1 block text-xs text-[var(--color-muted)]">发证机构</span>
                <input
                  className="input input-sm"
                  value={active.issuer}
                  onChange={(e) => patchActive({ issuer: e.target.value })}
                />
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
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xs text-[var(--color-muted)]">配色</p>
                <p className="text-[11px] text-[var(--color-muted-soft)]">
                  支持 <code>#RRGGBB</code> 与带透明度的 <code>#RRGGBBAA</code>；三位缩写会自动补全
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {PALETTE_FIELDS.map((f) => (
                  <ColorField
                    key={f.key}
                    label={f.label}
                    value={active.palette[f.key]}
                    onChange={(next) => patchPalette(f.key, next)}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs text-[var(--color-muted)]">分组标签库（用户勾选后计入强度，可自行增删改名）</p>
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
                  <div key={gIndex} className="rounded-surface border border-[var(--color-edge)] p-3">
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
                        const tags = e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean);
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
              <p className="mb-2 text-xs text-[var(--color-muted)]">等级称号（按 0–{hi} 区间命中，边界可共用）</p>
              <div className="flex flex-col gap-2">
                {active.ranks.map((rank, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={hi}
                      inputMode="numeric"
                      aria-label={`第 ${index + 1} 档起点`}
                      className="input input-sm w-20"
                      value={rank.min}
                      onChange={(e) => {
                        const min = Math.max(0, Math.min(hi, Math.round(Number(e.target.value) || 0)));
                        patchActive({
                          ranks: active.ranks.map((r, i) => (i === index ? { ...r, min } : r)),
                        });
                      }}
                    />
                    <span className="text-xs text-[var(--color-muted)]">–</span>
                    <input
                      type="number"
                      min={0}
                      max={hi}
                      inputMode="numeric"
                      aria-label={`第 ${index + 1} 档终点`}
                      className="input input-sm w-20"
                      value={rank.max}
                      onChange={(e) => {
                        const max = Math.max(0, Math.min(hi, Math.round(Number(e.target.value) || 0)));
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
                  // 新档从上一档终点+1 起（相接不重叠），终点跟当前主题的量表上限走。
                  const min = Math.min(last ? last.max + 1 : 0, hi);
                  patchActive({ ranks: [...active.ranks, { min, max: hi, name: "新等级" }] });
                }}
              >
                <Plus size={14} /> 增加一档
              </button>
            </div>

            <CertDrawSection
              theme={active}
              onChange={(draw) => patchActive({ draw })}
            />
          </div>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">没有可选主题，点左侧「新增主题」。</p>
        )}
      </div>
    </section>
  );
}

/** 抽取池配置：主题的「帮我选/抽取」改为服务端从小游戏区的任务包实时抽。 */
function CertDrawSection({
  theme,
  onChange,
}: {
  theme: CertTheme;
  onChange: (draw: CertTheme["draw"]) => void;
}) {
  const [packs, setPacks] = useState<{ id: number; name: string; enabled: boolean }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchAdminTaskPacks()
      .then((response) => {
        if (!cancelled) setPacks(response.packs.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })));
      })
      .catch(() => {
        if (!cancelled) setPacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const draw = theme.draw ?? null;

  return (
    <div className="rounded-surface border border-[var(--color-edge)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--color-muted)]">抽取池（可选，动态引用小游戏区的任务包）</p>
        {draw ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            <Trash2 size={14} /> 移除抽取池
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange({ packId: packs?.[0]?.id ?? 0, count: 1 })}
            disabled={!packs?.length}
          >
            <Plus size={14} /> 启用抽取池
          </button>
        )}
      </div>
      {!draw ? (
        <p className="mt-1 text-[11px] text-[var(--color-muted-soft)]">
          配置后，生成器的「帮我选/抽取」改为服务端实时从任务包抽条目；包更新后认证卡自动跟着变。任务包内容为 18+，抽取需通过门禁。
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="select select-sm"
            aria-label="抽取池任务包"
            value={draw.packId || ""}
            onChange={(e) => onChange({ ...draw, packId: Number(e.target.value) })}
          >
            <option value="" disabled>
              选择任务包…
            </option>
            {(packs ?? []).map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name}
                {pack.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
            每次抽取
            <input
              type="number"
              min={1}
              max={5}
              className="input input-sm w-16"
              value={draw.count}
              onChange={(e) =>
                onChange({ ...draw, count: Math.max(1, Math.min(5, Math.round(Number(e.target.value) || 1))) })
              }
            />
            条
          </label>
          <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
            按钮文案
            <input
              className="input input-sm w-36"
              maxLength={20}
              placeholder={draw.label || "帮我选"}
              value={draw.label ?? ""}
              onChange={(e) => onChange({ ...draw, label: e.target.value.trim() || undefined })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

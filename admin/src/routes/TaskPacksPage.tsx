import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import {
  createAdminTaskPack,
  deleteAdminTaskPack,
  fetchAdminTaskPacks,
  updateAdminTaskPack,
  type AdminTaskItemInput,
  type AdminTaskMode,
  type AdminTaskPack,
  type AdminTaskPersona,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";
import { SchemaForm } from "../game-plugins/SchemaForm";
import { loadClientPlugin } from "../game-plugins/loader";
import { normalizeConfig, validateWithSchema } from "../../../src/game-plugin/props";
import type { ConfigIssue, PropField } from "../../../src/game-plugin/types";
import type { GamePluginClient } from "../game-plugins/types";

const PERSONA_LABELS: Record<AdminTaskPersona, string> = {
  any: "通用",
  male: "公",
  female: "母",
};

const MODE_LABELS: Record<AdminTaskMode, string> = {
  any: "两种模式",
  normal: "普通",
  hell: "地狱",
};

/** 玩法类型展示名（与服务端 src/trial/engine-registry.ts 对齐；新玩法在此补一行）。 */
const GAME_TYPE_LABELS: Record<string, string> = {
  tower: "爬塔挑战",
};

function gameTypeLabel(value: string): string {
  return GAME_TYPE_LABELS[value] ?? value;
}

interface EditableItem {
  key: number;
  title: string;
  description: string;
  warning: string;
  score: number;
  persona: AdminTaskPersona;
  mode: AdminTaskMode;
  minFloor: number;
  maxFloor: number;
  enabled: boolean;
}

interface EditablePack {
  id: number | null;
  name: string;
  description: string;
  gameType: string;
  normalFloors: number;
  hellFloors: number;
  /** 一行一个的准备清单条目。 */
  prepItemsText: string;
  prepText: string;
  enabled: boolean;
  /** 插件玩法的配置（settings_json）；爬塔不用。 */
  settings: Record<string, unknown>;
  items: EditableItem[];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));
}

function packToEditable(pack: AdminTaskPack): EditablePack {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description ?? "",
    gameType: pack.gameType ?? "tower",
    normalFloors: pack.normalFloors,
    hellFloors: pack.hellFloors,
    prepItemsText: (pack.prepItems ?? []).join("\n"),
    prepText: pack.prepText ?? "",
    enabled: pack.enabled,
    settings: pack.settings ?? {},
    items: pack.items.map((item, index) => ({
      key: index,
      title: item.title,
      description: item.description,
      warning: item.warning ?? "",
      score: item.score,
      persona: item.persona,
      mode: item.mode,
      minFloor: item.minFloor,
      maxFloor: item.maxFloor,
      enabled: item.enabled,
    })),
  };
}

function blankPack(): EditablePack {
  return {
    id: null,
    name: "",
    description: "",
    gameType: "tower",
    normalFloors: 10,
    hellFloors: 12,
    prepItemsText: "",
    prepText: "",
    enabled: true,
    settings: {},
    items: [],
  };
}

function itemToInput(item: EditableItem, index: number): AdminTaskItemInput {
  return {
    title: item.title.trim(),
    description: item.description.trim(),
    warning: item.warning.trim(),
    score: clampInt(item.score, 1, 20),
    persona: item.persona,
    mode: item.mode,
    minFloor: clampInt(item.minFloor, 1, 60),
    maxFloor: clampInt(item.maxFloor, 1, 99),
    enabled: item.enabled,
    sortOrder: index,
  };
}

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select className="select h-9 w-full text-xs" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 编辑态预览：直接用插件自己的 EditView 渲染当前配置（所见即所得）。 */
function PluginEditPreview({
  plugin,
  config,
}: {
  plugin: GamePluginClient<readonly PropField[], unknown>;
  config: Record<string, unknown>;
}) {
  const EditView = plugin.EditView;
  return (
    <div className="rounded-xl border border-[var(--color-edge)] p-3">
      <p className="mb-2 text-[11px] font-semibold text-[var(--color-muted)]">玩法预览</p>
      <EditView config={config} mode="pro" onChange={() => {}} />
    </div>
  );
}

export function TaskPacksPage() {
  const { data, error, retry } = useApi<{ packs: AdminTaskPack[] }>("/api/admin/task-packs");
  const { confirm, toast } = useDialogs();

  const [editing, setEditing] = useState<EditablePack | null>(null);
  // 打开编辑器那一刻的快照：与当前 editing 的差异即「未保存修改」。
  // 快照在 openNew/openEdit 里显式拍摄——用 effect 依赖 id 会在「保存后再打开
  // 同一个包」和「连续两次新建」时漏拍（id 没变）。
  const editingBaseline = useRef("");
  const editingDirty = editing !== null && JSON.stringify(editing) !== editingBaseline.current;
  /** 退出编辑：有未保存修改时先确认（对照 CertContentPage 的离场守卫）。 */
  const exitEditor = async () => {
    if (
      editingDirty &&
      !(await confirm({
        title: "有未保存的修改",
        message: "任务包的修改还没保存，离开后会丢失。",
        confirmLabel: "离开",
        cancelLabel: "留下修改",
        variant: "danger",
      }))
    ) {
      return;
    }
    setEditing(null);
  };
  const [saving, setSaving] = useState(false);
  /** 玩法清单（服务端注册表），插件注册后自动出现在下拉里。 */
  const [gameTypes, setGameTypes] = useState<{ id: string; label: string; builtin: boolean }[]>([]);
  /** 当前正在编辑的插件客户端定义（取 props 生成属性面板）。 */
  const [pluginDef, setPluginDef] = useState<GamePluginClient<readonly PropField[], unknown> | null>(null);
  /** 正在切换「玩家端可见」的包 id：开关是整包全量更新，连点会互相覆盖。 */
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const nextItemKey = useRef(1000);

  // 玩法清单：/api/trial/packs 的 gameTypes 直接来自服务端注册表。
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/trial/packs")
      .then(
        (response) =>
          response.json() as Promise<{ gameTypes?: Array<{ id: string; label: string; builtin: boolean }> }>,
      )
      .then((payload) => {
        if (!cancelled) setGameTypes(payload.gameTypes ?? []);
      })
      .catch(() => {
        // 拉不到就退回内置标签表，不影响编辑爬塔包。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const editingGameType = editing?.gameType ?? "tower";
  useEffect(() => {
    if (editingGameType === "tower") {
      setPluginDef(null);
      return;
    }
    let cancelled = false;
    void loadClientPlugin(editingGameType)
      .then((plugin) => {
        if (!cancelled) setPluginDef(plugin as unknown as GamePluginClient<readonly PropField[], unknown>);
      })
      .catch(() => {
        if (!cancelled) setPluginDef(null);
      });
    return () => {
      cancelled = true;
    };
  }, [editingGameType]);

  /** 插件配置的实时问题（Schema 结构 + 插件自定义），保存前用它拦。 */
  const pluginIssues = useMemo<ConfigIssue[]>(() => {
    if (!editing || editing.gameType === "tower" || !pluginDef) return [];
    const normalized = normalizeConfig(pluginDef.props, editing.settings);
    return [
      ...validateWithSchema(pluginDef.props, normalized),
      ...(pluginDef.validate ? pluginDef.validate(normalized) : []),
    ];
  }, [editing, pluginDef]);

  const packItems = useMemo(() => {
    if (!data) return [];
    const enabled = data.packs.filter((pack) => pack.enabled);
    const disabled = data.packs.filter((pack) => !pack.enabled);
    return [...enabled, ...disabled];
  }, [data]);

  const openNew = () => {
    setSaveError(null);
    const blank = blankPack();
    editingBaseline.current = JSON.stringify(blank);
    setEditing(blank);
  };

  const openEdit = (pack: AdminTaskPack) => {
    setSaveError(null);
    nextItemKey.current = Math.max(nextItemKey.current, pack.items.length);
    const editable = packToEditable(pack);
    editingBaseline.current = JSON.stringify(editable);
    setEditing(editable);
  };

  const updateMeta = (patch: Partial<EditablePack>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current));
  };

  const updateItem = (key: number, patch: Partial<EditableItem>) => {
    setEditing((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) }
        : current,
    );
  };

  const removeItem = (key: number) => {
    setEditing((current) =>
      current ? { ...current, items: current.items.filter((item) => item.key !== key) } : current,
    );
  };

  const moveItem = (index: number, delta: -1 | 1) => {
    setEditing((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.items.length) return current;
      const items = [...current.items];
      const [moved] = items.splice(index, 1);
      if (!moved) return current;
      items.splice(target, 0, moved);
      return { ...current, items };
    });
  };

  const addItem = () => {
    setEditing((current) => {
      if (!current) return current;
      const key = nextItemKey.current++;
      return {
        ...current,
        items: [
          ...current.items,
          {
            key,
            title: "",
            description: "",
            warning: "",
            score: 5,
            persona: "any",
            mode: "any",
            minFloor: 1,
            maxFloor: Math.max(current.normalFloors, current.hellFloors),
            enabled: true,
          },
        ],
      };
    });
  };

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setSaveError("任务包名称不能为空");
      return;
    }
    const isPlugin = editing.gameType !== "tower";
    const items = editing.items
      .map((item, index) => itemToInput(item, index))
      .filter((item) => (isPlugin ? true : item.title && item.description));
    // 爬塔包必须有完整的任务行；插件包的必填项由 Schema 校验（pluginIssues）。
    if (!isPlugin && editing.items.length > 0 && items.length !== editing.items.length) {
      setSaveError("部分任务缺少标题或描述，请补全后再保存（空行会被丢弃）");
      return;
    }
    if (isPlugin && pluginIssues.some((issue) => issue.severity === "error")) {
      setSaveError(pluginIssues.map((issue) => issue.message).join("；"));
      return;
    }
    const body = {
      name,
      description: editing.description.trim() || null,
      gameType: editing.gameType,
      normalFloors: clampInt(editing.normalFloors, 1, 60),
      hellFloors: clampInt(editing.hellFloors, 1, 60),
      prepItems: editing.prepItemsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      prepText: editing.prepText.trim() || null,
      enabled: editing.enabled,
      ...(isPlugin ? { settings: editing.settings } : {}),
      items,
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (editing.id === null) {
        await createAdminTaskPack(body);
      } else {
        await updateAdminTaskPack(editing.id, body);
      }
      setEditing(null);
      retry();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (pack: AdminTaskPack) => {
    if (!(await confirm({ message: `确定删除小游戏包「${pack.name}」吗？历史挑战记录不受影响。`, variant: "danger" })))
      return;
    try {
      await deleteAdminTaskPack(pack.id);
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "删除失败", variant: "error" });
    }
  };

  const toggleEnabled = async (pack: AdminTaskPack, enabled: boolean) => {
    if (togglingId !== null) return;
    setTogglingId(pack.id);
    try {
      await updateAdminTaskPack(pack.id, {
        name: pack.name,
        description: pack.description,
        normalFloors: pack.normalFloors,
        hellFloors: pack.hellFloors,
        prepItems: pack.prepItems ?? [],
        prepText: pack.prepText ?? null,
        enabled,
        items: pack.items.map((item, index) => ({
          title: item.title,
          description: item.description,
          warning: item.warning ?? "",
          score: item.score,
          persona: item.persona,
          mode: item.mode,
          minFloor: item.minFloor,
          maxFloor: item.maxFloor,
          enabled: item.enabled,
          sortOrder: index,
        })),
      });
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" });
    } finally {
      setTogglingId(null);
    }
  };

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <button type="button" className="btn btn-sm gap-1.5" onClick={() => void exitEditor()} disabled={saving}>
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </button>
          <div className="flex items-center gap-2">
            {saveError ? <span className="text-xs text-[var(--app-danger)]">{saveError}</span> : null}
            <button
              type="button"
              className="btn btn-sm gap-1.5 btn-primary"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save className="h-4 w-4" />
              {saving ? "保存中…" : "保存任务包"}
            </button>
          </div>
        </div>

        <section className="card">
          <h2 className="text-sm font-bold text-[var(--color-ink)]">
            {editing.id === null ? "新建任务包" : `编辑「${editing.name || "未命名"}」`}
          </h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <label className="block text-xs font-medium text-[var(--color-muted)]">
              玩法类型
              <select
                className="select mt-1 h-9 w-full text-xs"
                value={editing.gameType}
                onChange={(event) => updateMeta({ gameType: event.target.value, settings: {} })}
              >
                {(gameTypes.length
                  ? gameTypes
                  : Object.entries(GAME_TYPE_LABELS).map(([id, label]) => ({ id, label, builtin: id === "tower" }))
                ).map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.label}
                    {type.builtin ? "（内置）" : ""}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--color-muted-soft)]">
                玩法清单来自服务端注册表：新插件注册后自动出现在这里，无需改编辑器。
              </span>
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)]">
              名称
              <input
                className="input mt-1 w-full"
                value={editing.name}
                maxLength={60}
                placeholder="例如：楼道挑战"
                onChange={(event) => updateMeta({ name: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
              描述（玩家端展示，可写玩法说明与 18+ 提示）
              <textarea
                className="input mt-1 min-h-16 w-full py-2"
                value={editing.description}
                maxLength={300}
                onChange={(event) => updateMeta({ description: event.target.value })}
              />
            </label>
            {editing.gameType === "tower" ? (
              <>
                <label className="block text-xs font-medium text-[var(--color-muted)]">
                  普通模式层数
                  <input
                    type="number"
                    min={1}
                    max={60}
                    className="input mt-1 w-full"
                    value={editing.normalFloors}
                    onChange={(event) => updateMeta({ normalFloors: Number(event.target.value) })}
                  />
                </label>
                <label className="block text-xs font-medium text-[var(--color-muted)]">
                  地狱模式层数
                  <input
                    type="number"
                    min={1}
                    max={60}
                    className="input mt-1 w-full"
                    value={editing.hellFloors}
                    onChange={(event) => updateMeta({ hellFloors: Number(event.target.value) })}
                  />
                </label>
                <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
                  开始前准备清单（每行一条，玩家开局前展示）
                  <textarea
                    className="input mt-1 min-h-20 w-full py-2"
                    value={editing.prepItemsText}
                    maxLength={600}
                    placeholder={"手机（计时用）\n一杯水\n便签纸和笔"}
                    onChange={(event) => updateMeta({ prepItemsText: event.target.value })}
                  />
                </label>
                <label className="block text-xs font-medium text-[var(--color-muted)] lg:col-span-2">
                  准备提示（一句话，随清单一起展示）
                  <input
                    className="input mt-1 w-full"
                    value={editing.prepText}
                    maxLength={300}
                    placeholder="例如：出发前把清单上的物品摆在门口，按顺序确认。"
                    onChange={(event) => updateMeta({ prepText: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <p className="text-xs text-[var(--color-muted-soft)] lg:col-span-2">
                插件玩法不需要楼层与准备清单；内容在下方「玩法配置」里维护。
              </p>
            )}
            <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-[var(--color-muted)]">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={editing.enabled}
                onChange={(event) => updateMeta({ enabled: event.target.checked })}
              />
              玩家端可见
            </label>
          </div>
        </section>

        {editing.gameType === "tower" ? (
          <section className="card">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-sm font-bold text-[var(--color-ink)]">任务列表（{editing.items.length}）</h2>
              <button type="button" className="btn btn-sm gap-1.5" onClick={addItem}>
                <Plus className="h-4 w-4" />
                添加任务
              </button>
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
              任务按楼层区间与身份/模式过滤抽取；改动保存后玩家端实时生效。
            </p>

            {editing.items.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-[var(--color-edge)] p-8 text-center text-sm text-[var(--color-muted-soft)] ">
                还没有任务。先添加一个吧——每个任务需要标题与描述，保存时会按当前顺序编号。
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {editing.items.map((item, index) => (
                  <article key={item.key} className="rounded-xl border border-[var(--color-edge)] p-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="text-xs font-bold text-[var(--color-muted-soft)]">#{index + 1}</span>
                      <div className="flex items-center gap-1">
                        <label className="flex items-center gap-1 pr-1 text-[11px] text-[var(--color-muted-soft)]">
                          <input
                            type="checkbox"
                            className="checkbox checkbox-xs"
                            checked={item.enabled}
                            onChange={(event) => updateItem(item.key, { enabled: event.target.checked })}
                          />
                          启用
                        </label>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={index === 0}
                          onClick={() => moveItem(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={index === editing.items.length - 1}
                          onClick={() => moveItem(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label="删除任务"
                          className="btn btn-ghost btn-xs text-[var(--app-danger)]"
                          onClick={() => removeItem(item.key)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 lg:grid-cols-12">
                      <input
                        className="input lg:col-span-3"
                        placeholder="任务标题（会展示给玩家）"
                        value={item.title}
                        maxLength={60}
                        onChange={(event) => updateItem(item.key, { title: event.target.value })}
                      />
                      <textarea
                        className="input min-h-12 py-2 lg:col-span-6"
                        placeholder="任务描述——完整动作与心理描写（虚构情境）"
                        value={item.description}
                        maxLength={3000}
                        onChange={(event) => updateItem(item.key, { description: event.target.value })}
                      />
                      <div className="grid grid-cols-2 gap-2 lg:col-span-3">
                        <label className="text-[11px] text-[var(--color-muted-soft)]">
                          分值
                          <input
                            type="number"
                            min={1}
                            max={20}
                            className="input mt-0.5 w-full"
                            value={item.score}
                            onChange={(event) => updateItem(item.key, { score: Number(event.target.value) })}
                          />
                        </label>
                        <label className="text-[11px] text-[var(--color-muted-soft)]">
                          身份
                          <SelectField
                            value={item.persona}
                            onChange={(value) => updateItem(item.key, { persona: value as AdminTaskPersona })}
                            options={Object.entries(PERSONA_LABELS).map(([value, label]) => ({ value, label }))}
                          />
                        </label>
                        <label className="text-[11px] text-[var(--color-muted-soft)]">
                          模式
                          <SelectField
                            value={item.mode}
                            onChange={(value) => updateItem(item.key, { mode: value as AdminTaskMode })}
                            options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-1.5">
                          <label className="text-[11px] text-[var(--color-muted-soft)]">
                            起始层
                            <input
                              type="number"
                              min={1}
                              max={60}
                              className="input mt-0.5 w-full"
                              value={item.minFloor}
                              onChange={(event) => updateItem(item.key, { minFloor: Number(event.target.value) })}
                            />
                          </label>
                          <label className="text-[11px] text-[var(--color-muted-soft)]">
                            结束层
                            <input
                              type="number"
                              min={1}
                              max={99}
                              className="input mt-0.5 w-full"
                              value={item.maxFloor}
                              onChange={(event) => updateItem(item.key, { maxFloor: Number(event.target.value) })}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                    <label className="mt-2 block text-[11px] text-[var(--color-muted-soft)]">
                      风险弹窗提醒（可选，留空则无弹窗；建议用于危险动作 / 公共场合 / 违法边缘内容）
                      <textarea
                        className="input mt-1 min-h-8 w-full py-2"
                        value={item.warning}
                        maxLength={300}
                        onChange={(event) => updateItem(item.key, { warning: event.target.value })}
                      />
                    </label>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="card">
            <h2 className="text-sm font-bold text-[var(--color-ink)]">玩法配置</h2>
            <p className="mt-1 text-xs text-[var(--color-muted-soft)]">
              面板由插件声明的属性 Schema 自动生成；保存时服务端会再按同一套规则归一化。
            </p>
            {pluginDef ? (
              <div className="mt-4 space-y-4">
                <SchemaForm
                  fields={pluginDef.props}
                  value={normalizeConfig(pluginDef.props, editing.settings)}
                  mode="pro"
                  issues={pluginIssues}
                  disabled={saving}
                  onChange={(next) => updateMeta({ settings: next })}
                />
                <PluginEditPreview plugin={pluginDef} config={normalizeConfig(pluginDef.props, editing.settings)} />
              </div>
            ) : (
              <p className="mt-3 text-xs text-[var(--color-muted-soft)]">
                {editing.gameType === "tower" ? "" : "该玩法还没有客户端实现，无法在此配置。"}
              </p>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-[var(--color-ink)]">小游戏管理</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            内容与机制分离：任务文案存库，改动立即对玩家端生效；玩法类型由引擎注册表管理。
          </p>
        </div>
        <button type="button" className="btn btn-sm gap-1.5 btn-primary" onClick={openNew}>
          <Plus className="h-4 w-4" />
          新建小游戏包
        </button>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : data === null ? (
        <SkeletonPanel lines={5} />
      ) : packItems.length === 0 ? (
        <EmptyPanel text="还没有小游戏包，先新建一个吧" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {packItems.map((pack) => (
            <article key={pack.id} className="card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-[var(--color-ink)]">{pack.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-muted)]">
                    {pack.description || "（暂无描述）"}
                  </p>
                </div>
                <span className={pack.enabled ? "badge badge-green" : "badge badge-gray"}>
                  {pack.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-ink)] dark:text-[var(--color-muted-soft)]">
                <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">
                  {gameTypeLabel(pack.gameType ?? "tower")}
                </span>
                <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">普通 {pack.normalFloors} 层</span>
                <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">地狱 {pack.hellFloors} 层</span>
                <span className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5">
                  {pack.items.filter((item) => item.enabled).length} 个任务
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between flex-wrap gap-2 border-t border-[var(--color-edge)] pt-3 flex-wrap">
                <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={pack.enabled}
                    disabled={togglingId !== null}
                    onChange={(event) => void toggleEnabled(pack, event.target.checked)}
                  />
                  玩家端可见
                </label>
                <div className="flex gap-1.5">
                  <button type="button" className="btn btn-sm" onClick={() => openEdit(pack)}>
                    编辑任务
                  </button>
                  <button
                    type="button"
                    aria-label="删除任务包"
                    className="btn btn-sm btn-ghost text-[var(--app-danger)]"
                    onClick={() => void remove(pack)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

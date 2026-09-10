import { useMemo, useRef, useState } from "react";
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
  normalFloors: number;
  hellFloors: number;
  /** 一行一个的准备清单条目。 */
  prepItemsText: string;
  prepText: string;
  enabled: boolean;
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
    normalFloors: pack.normalFloors,
    hellFloors: pack.hellFloors,
    prepItemsText: (pack.prepItems ?? []).join("\n"),
    prepText: pack.prepText ?? "",
    enabled: pack.enabled,
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
    normalFloors: 10,
    hellFloors: 12,
    prepItemsText: "",
    prepText: "",
    enabled: true,
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

export function TaskPacksPage() {
  const { data, error, retry } = useApi<{ packs: AdminTaskPack[] }>("/api/admin/task-packs");
  const { confirm, toast } = useDialogs();

  const [editing, setEditing] = useState<EditablePack | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const nextItemKey = useRef(1000);

  const packItems = useMemo(() => {
    if (!data) return [];
    const enabled = data.packs.filter((pack) => pack.enabled);
    const disabled = data.packs.filter((pack) => !pack.enabled);
    return [...enabled, ...disabled];
  }, [data]);

  const openNew = () => {
    setSaveError(null);
    setEditing(blankPack());
  };

  const openEdit = (pack: AdminTaskPack) => {
    setSaveError(null);
    nextItemKey.current = Math.max(nextItemKey.current, pack.items.length);
    setEditing(packToEditable(pack));
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
    const items = editing.items
      .map((item, index) => itemToInput(item, index))
      .filter((item) => item.title && item.description);
    if (editing.items.length > 0 && items.length !== editing.items.length) {
      setSaveError("部分任务缺少标题或描述，请补全后再保存（空行会被丢弃）");
      return;
    }
    const body = {
      name,
      description: editing.description.trim() || null,
      normalFloors: clampInt(editing.normalFloors, 1, 60),
      hellFloors: clampInt(editing.hellFloors, 1, 60),
      prepItems: editing.prepItemsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      prepText: editing.prepText.trim() || null,
      enabled: editing.enabled,
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
    if (!await confirm({ message: `确定删除任务包「${pack.name}」吗？历史挑战记录不受影响。`, variant: "danger" })) return;
    try {
      await deleteAdminTaskPack(pack.id);
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "删除失败", variant: "error" });
    }
  };

  const toggleEnabled = async (pack: AdminTaskPack, enabled: boolean) => {
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
    }
  };

  if (editing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <button type="button" className="btn btn-sm gap-1.5" onClick={() => setEditing(null)} disabled={saving}>
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </button>
          <div className="flex items-center gap-2">
            {saveError ? <span className="text-xs text-red-500">{saveError}</span> : null}
            <button
              type="button"
              className="btn btn-sm gap-1.5 bg-indigo-600 text-white hover:bg-indigo-500"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save className="h-4 w-4" />
              {saving ? "保存中…" : "保存任务包"}
            </button>
          </div>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            {editing.id === null ? "新建任务包" : `编辑「${editing.name || "未命名"}」`}
          </h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
              名称
              <input
                className="input mt-1 w-full"
                value={editing.name}
                maxLength={60}
                placeholder="例如：楼道挑战"
                onChange={(event) => updateMeta({ name: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 lg:col-span-2">
              描述（玩家端展示，可写玩法说明与 18+ 提示）
              <textarea
                className="input mt-1 min-h-16 w-full py-2"
                value={editing.description}
                maxLength={300}
                onChange={(event) => updateMeta({ description: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
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
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400">
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
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 lg:col-span-2">
              开始前准备清单（每行一条，玩家开局前展示）
              <textarea
                className="input mt-1 min-h-20 w-full py-2"
                value={editing.prepItemsText}
                maxLength={600}
                placeholder={"手机（计时用）\n一杯水\n便签纸和笔"}
                onChange={(event) => updateMeta({ prepItemsText: event.target.value })}
              />
            </label>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 lg:col-span-2">
              准备提示（一句话，随清单一起展示）
              <input
                className="input mt-1 w-full"
                value={editing.prepText}
                maxLength={300}
                placeholder="例如：出发前把清单上的物品摆在门口，按顺序确认。"
                onChange={(event) => updateMeta({ prepText: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 self-end pb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
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

        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">任务列表（{editing.items.length}）</h2>
            <button type="button" className="btn btn-sm gap-1.5" onClick={addItem}>
              <Plus className="h-4 w-4" />
              添加任务
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-400">任务按楼层区间与身份/模式过滤抽取；改动保存后玩家端实时生效。</p>

          {editing.items.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400 dark:border-slate-600">
              还没有任务。先添加一个吧——每个任务需要标题与描述，保存时会按当前顺序编号。
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {editing.items.map((item, index) => (
                <article key={item.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-400">#{index + 1}</span>
                    <div className="flex items-center gap-1">
                      <label className="flex items-center gap-1 pr-1 text-[11px] text-slate-400">
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
                        className="btn btn-ghost btn-xs text-red-500"
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
                      <label className="text-[11px] text-slate-400">
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
                      <label className="text-[11px] text-slate-400">
                        身份
                        <SelectField
                          value={item.persona}
                          onChange={(value) => updateItem(item.key, { persona: value as AdminTaskPersona })}
                          options={Object.entries(PERSONA_LABELS).map(([value, label]) => ({ value, label }))}
                        />
                      </label>
                      <label className="text-[11px] text-slate-400">
                        模式
                        <SelectField
                          value={item.mode}
                          onChange={(value) => updateItem(item.key, { mode: value as AdminTaskMode })}
                          options={Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }))}
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="text-[11px] text-slate-400">
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
                        <label className="text-[11px] text-slate-400">
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
                  <label className="mt-2 block text-[11px] text-slate-400">
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
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">任务包</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            内容与机制分离：任务文案存库，改动立即对玩家端生效。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm gap-1.5 bg-indigo-600 text-white hover:bg-indigo-500"
          onClick={openNew}
        >
          <Plus className="h-4 w-4" />
          新建任务包
        </button>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : data === null ? (
        <SkeletonPanel lines={5} />
      ) : packItems.length === 0 ? (
        <EmptyPanel text="还没有任务包，先新建一个吧" />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {packItems.map((pack) => (
            <article
              key={pack.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{pack.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {pack.description || "（暂无描述）"}
                  </p>
                </div>
                <span
                  className={
                    pack.enabled
                      ? "shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : "shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  }
                >
                  {pack.enabled ? "已启用" : "已停用"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                  普通 {pack.normalFloors} 层
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                  地狱 {pack.hellFloors} 层
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
                  {pack.items.filter((item) => item.enabled).length} 个任务
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={pack.enabled}
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
                    className="btn btn-sm btn-ghost text-red-500"
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

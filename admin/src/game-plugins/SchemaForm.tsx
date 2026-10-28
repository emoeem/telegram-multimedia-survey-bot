import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, Upload } from "lucide-react";
import type { ConfigIssue, PropField } from "../../../src/game-plugin/types";
import { fetchAdminMediaLibrary, uploadAdminMediaLibrary, type AdminMediaLibraryItem } from "../api";

/**
 * Schema 驱动的属性面板：插件声明 PropField[]，这里负责渲染与取值。
 *
 * 为什么不给每个插件手写表单：属性面板是编辑器里最容易分叉的地方——
 * 手写一份就要维护校验/默认值/基础模式/错误定位四件事，每加一个玩法都要
 * 重来一遍。SchemaForm 把"字段 → 控件"收敛成一处穷尽 switch（新增字段
 * 类型时 TS 会强制你在这里补分支）。
 */
export function SchemaForm({
  fields,
  value,
  mode,
  issues,
  disabled,
  onChange,
}: {
  fields: readonly PropField[];
  value: Record<string, unknown>;
  mode: "basic" | "pro";
  issues: readonly ConfigIssue[];
  disabled?: boolean;
  onChange(next: Record<string, unknown>): void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        if (mode === "basic" && field.basic === false) return null;
        if (field.when && !field.when(value)) return null;
        const issue = issues.find((item) => item.key === field.key);
        return (
          <FieldRow
            key={field.key}
            field={field}
            value={value[field.key]}
            mode={mode}
            disabled={disabled}
            issue={issue}
            onChange={(next) => onChange({ ...value, [field.key]: next })}
          />
        );
      })}
    </div>
  );
}

function FieldRow({
  field,
  value,
  mode,
  disabled,
  issue,
  onChange,
}: {
  field: PropField;
  value: unknown;
  mode: "basic" | "pro";
  disabled?: boolean;
  issue?: ConfigIssue;
  onChange(next: unknown): void;
}) {
  const help = field.help ? <span className="mt-0.5 block text-[11px] text-[var(--color-muted-soft)]">{field.help}</span> : null;
  const error = issue ? (
    <span className={`mt-0.5 block text-[11px] ${issue.severity === "error" ? "text-[var(--app-danger)]" : "text-[var(--app-warning)]"}`}>
      {issue.message}
    </span>
  ) : null;

  switch (field.kind) {
    case "text":
      return (
        <label className="block text-xs font-medium text-[var(--color-muted)]">
          {field.label}
          <input
            className="input mt-1 w-full"
            value={typeof value === "string" ? value : ""}
            maxLength={field.maxLength}
            placeholder={field.placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {help}
          {error}
        </label>
      );
    case "textarea":
      return (
        <label className="block text-xs font-medium text-[var(--color-muted)]">
          {field.label}
          <textarea
            className="input mt-1 w-full py-2"
            rows={field.rows ?? 3}
            value={typeof value === "string" ? value : ""}
            maxLength={field.maxLength}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {help}
          {error}
        </label>
      );
    case "number":
      return (
        <label className="block text-xs font-medium text-[var(--color-muted)]">
          {field.label}
          <input
            type="number"
            className="input mt-1 w-full"
            value={typeof value === "number" ? value : field.default}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          {help}
          {error}
        </label>
      );
    case "boolean":
      return (
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--color-muted)]">
          <span>
            {field.label}
            {help}
          </span>
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        </label>
      );
    case "select":
      return (
        <label className="block text-xs font-medium text-[var(--color-muted)]">
          {field.label}
          <select
            className="select mt-1 w-full"
            value={typeof value === "string" ? value : field.default}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {help}
          {error}
        </label>
      );
    case "media":
      return (
        <div className="text-xs font-medium text-[var(--color-muted)]">
          {field.label}
          <MediaField
            accept={field.accept}
            assetId={typeof value === "number" ? value : null}
            disabled={disabled}
            onChange={onChange}
          />
          {help}
          {error}
        </div>
      );
    case "list":
      return (
        <ListItemField
          field={field}
          value={Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []}
          mode={mode}
          disabled={disabled}
          error={error}
          onChange={onChange}
        />
      );
  }
}

/** 素材库选择：缩略图列表 + 直接上传（走 /api/admin/media-library，含去重）。 */
function MediaField({
  accept,
  assetId,
  disabled,
  onChange,
}: {
  accept: "image" | "audio" | "video" | "any";
  assetId: number | null;
  disabled?: boolean;
  onChange(next: number | null): void;
}) {
  const [items, setItems] = useState<AdminMediaLibraryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const mimePrefix = accept === "any" ? undefined : accept;
  useEffect(() => {
    let cancelled = false;
    void fetchAdminMediaLibrary({ limit: 24, offset: 0, ...(mimePrefix ? { mime: mimePrefix } : {}) })
      .then((response) => {
        if (!cancelled) setItems(response.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mimePrefix]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const uploaded = await uploadAdminMediaLibrary(file);
      onChange(uploaded.assetId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {assetId ? (
          <span className="flex items-center gap-1.5 rounded-lg border border-[var(--color-edge)] px-2 py-1 text-[11px]">
            {accept === "image" || accept === "any" ? (
              <img src={`/api/survey/media/${assetId}`} alt="" className="h-8 w-8 rounded object-cover" />
            ) : null}
            #{assetId}
            <button type="button" className="text-[var(--app-danger)]" onClick={() => onChange(null)} disabled={disabled}>
              清除
            </button>
          </span>
        ) : (
          <span className="text-[11px] text-[var(--color-muted-soft)]">未选择</span>
        )}
        <label className="btn btn-ghost btn-xs gap-1">
          <Upload className="h-3 w-3" />
          {busy ? "上传中…" : "上传"}
          <input
            type="file"
            className="hidden"
            disabled={disabled || busy}
            accept={accept === "any" ? undefined : `${accept}/*`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {items && items.length > 0 ? (
        <div className="mt-1.5 grid max-h-32 grid-cols-6 gap-1 overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.fileName ?? `#${item.id}`}
              disabled={disabled}
              onClick={() => onChange(item.id)}
              className={`aspect-square overflow-hidden rounded border ${
                assetId === item.id ? "border-[var(--color-primary)]" : "border-[var(--color-edge)]"
              }`}
            >
              {item.mimeType?.startsWith("image/") ? (
                <img src={`/api/survey/media/${item.id}`} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <span className="grid h-full w-full place-items-center text-[9px] text-[var(--color-muted-soft)]">
                  {(item.mimeType ?? "").split("/").pop()}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 重复项：增删/上下移 + 子字段递归渲染（卡组里的选项就是嵌套 list）。 */
function ListItemField({
  field,
  value,
  mode,
  disabled,
  error,
  onChange,
}: {
  field: Extract<PropField, { kind: "list" }>;
  value: Array<Record<string, unknown>>;
  mode: "basic" | "pro";
  disabled?: boolean;
  error?: React.ReactNode;
  onChange(next: Array<Record<string, unknown>>): void;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(value.length > 0 ? 0 : null);
  const blank = useMemo(() => {
    const item: Record<string, unknown> = {};
    for (const child of field.itemFields) {
      item[child.key] =
        child.kind === "list" ? [] : child.kind === "media" ? null : (child as { default: unknown }).default;
    }
    return item;
  }, [field.itemFields]);

  const patch = (index: number, nextItem: Record<string, unknown>) => {
    onChange(value.map((item, i) => (i === index ? nextItem : item)));
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    onChange(next);
    setOpenIndex(target);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-muted)]">
          {field.label}（{value.length}/{field.maxItems}）
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1"
          disabled={disabled || value.length >= field.maxItems}
          onClick={() => {
            onChange([...value, { ...blank }]);
            setOpenIndex(value.length);
          }}
        >
          <Plus className="h-3 w-3" /> 添加
        </button>
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {value.map((item, index) => {
          const open = openIndex === index;
          return (
            <div key={index} className="rounded-lg border border-[var(--color-edge)]">
              <div className="flex items-center gap-1 px-2 py-1.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-xs font-medium text-[var(--color-ink)]"
                  onClick={() => setOpenIndex(open ? null : index)}
                >
                  {field.itemLabel(item, index)}
                </button>
                <button type="button" className="btn btn-ghost btn-xs" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label="上移">
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button type="button" className="btn btn-ghost btn-xs" disabled={disabled || index === value.length - 1} onClick={() => move(index, 1)} aria-label="下移">
                  <ChevronDown className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-[var(--app-danger)]"
                  disabled={disabled}
                  aria-label="删除该项"
                  onClick={() => {
                    onChange(value.filter((_, i) => i !== index));
                    setOpenIndex(null);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              {open ? (
                <div className="border-t border-[var(--color-edge)] p-2">
                  <SchemaForm
                    fields={field.itemFields}
                    value={item}
                    mode={mode}
                    disabled={disabled}
                    issues={[]}
                    onChange={(nextItem) => patch(index, nextItem)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
        {value.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-edge)] p-3 text-center text-[11px] text-[var(--color-muted-soft)]">
            还没有内容，点「添加」开始
          </p>
        ) : null}
      </div>
      {error}
    </div>
  );
}

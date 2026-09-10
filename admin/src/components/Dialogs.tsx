import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type DialogVariant = "default" | "danger";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
}

export interface ToastOptions {
  message: string;
  variant?: "success" | "error" | "info";
  durationMs?: number;
}

interface InternalConfirmItem extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

interface InternalToastItem extends ToastOptions {
  id: number;
}

interface DialogsContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (options: ToastOptions) => void;
}

const DialogsContext = createContext<DialogsContextValue | null>(null);

export function useDialogs(): DialogsContextValue {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs must be used within <DialogsProvider>");
  return ctx;
}

let nextId = 1;

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [confirms, setConfirms] = useState<InternalConfirmItem[]>([]);
  const [toasts, setToasts] = useState<InternalToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setConfirms((prev) => [...prev, { id: nextId++, ...options, resolve }]);
    });
  }, []);

  const toast = useCallback((options: ToastOptions): void => {
    const duration = options.durationMs ?? (options.variant === "error" ? 5000 : 3000);
    const id = nextId++;
    setToasts((prev) => [...prev, { id, ...options }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, duration);
    timersRef.current.set(id, timer);
  }, []);

  const handleConfirm = useCallback((id: number, ok: boolean) => {
    setConfirms((prev) => {
      const item = prev.find((c) => c.id === id);
      if (item) item.resolve(ok);
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  return (
    <DialogsContext.Provider value={{ confirm, toast }}>
      {children}
      <ConfirmDialogStack items={confirms} onConfirm={handleConfirm} />
      <ToastStack items={toasts} />
    </DialogsContext.Provider>
  );
}

function ConfirmDialogStack({
  items,
  onConfirm,
}: {
  items: InternalConfirmItem[];
  onConfirm: (id: number, ok: boolean) => void;
}) {
  if (items.length === 0) return null;
  const top = items[items.length - 1]!;
  const variant = top.variant ?? "default";
  const title = top.title ?? (variant === "danger" ? "确认操作" : "提示");
  const confirmLabel = top.confirmLabel ?? (variant === "danger" ? "确认" : "确定");
  const cancelLabel = top.cancelLabel ?? "取消";
  const danger = variant === "danger";

  return (
    <>
      {items.slice(0, -1).map((c) => (
        <div key={c.id} className="pointer-events-none fixed inset-0 z-[100]" aria-hidden />
      ))}
      <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 px-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          className="w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--surface)] shadow-2xl"
        >
          <div className="flex items-start gap-3 p-5">
            <div
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                danger
                  ? "bg-[color-mix(in_srgb,var(--color-danger)_15%,var(--surface))] text-[var(--color-danger)]"
                  : "bg-[color-mix(in_srgb,var(--color-primary)_12%,var(--surface))] text-[var(--color-primary)]"
              }`}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="dialog-title" className="text-base font-bold tracking-tight">
                {title}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--color-muted)]">{top.message}</p>
            </div>
          </div>
          <div className="flex border-t border-[var(--color-edge-soft)]">
            <button
              type="button"
              onClick={() => onConfirm(top.id, false)}
              className="flex-1 border-r border-[var(--color-edge-soft)] py-3 text-sm font-semibold text-[var(--color-muted)] transition-colors hover:bg-black/5"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(top.id, true)}
              className={`flex-1 py-3 text-sm font-bold transition-colors ${
                danger
                  ? "text-[var(--color-danger)] hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,var(--surface))]"
                  : "text-[var(--color-primary)] hover:bg-black/5"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ToastStack({ items }: { items: InternalToastItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[101] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <ToastItem key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastItem({ item }: { item: InternalToastItem }) {
  const variant = item.variant ?? "info";
  const Icon = variant === "success" ? CheckCircle2 : variant === "error" ? X : Info;
  const color =
    variant === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
      : variant === "error"
        ? "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
        : "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";
  const iconColor =
    variant === "success"
      ? "text-emerald-500 dark:text-emerald-400"
      : variant === "error"
        ? "text-red-500 dark:text-red-400"
        : "text-slate-500 dark:text-slate-400";

  return (
    <div
      role="status"
      className={`pointer-events-auto flex min-w-[260px] max-w-md items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${color}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
      <span className="break-words">{item.message}</span>
    </div>
  );
}

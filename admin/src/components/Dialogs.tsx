import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { trapFocusWithin } from "./focus-trap";

export type DialogVariant = "default" | "danger";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
}

/**
 * A one-button dialog for statements the user can only acknowledge ("无法保存，
 * 这是 3 条问题"). It exists because a two-button confirm forces every such
 * caller to invent a fake second choice — that is how "返回修改 / 知道了" ended
 * up as two buttons that do exactly the same thing.
 */
export interface AlertOptions {
  title?: string;
  message: string;
  buttonLabel?: string;
  variant?: DialogVariant;
}

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastOptions {
  message: string;
  variant?: "success" | "error" | "info";
  durationMs?: number;
  action?: ToastAction;
  countdownMs?: number;
}

interface InternalConfirmItem extends ConfirmOptions {
  id: number;
  kind: "confirm";
  resolve: (ok: boolean) => void;
}

interface InternalAlertItem extends AlertOptions {
  id: number;
  kind: "alert";
  resolve: () => void;
}

/** One queue, so an alert and a confirm can never stack on top of each other. */
type InternalDialogItem = InternalConfirmItem | InternalAlertItem;

interface InternalToastItem extends ToastOptions {
  id: number;
}

interface DialogsContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  alert: (options: AlertOptions) => Promise<void>;
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
  const [dialogs, setDialogs] = useState<InternalDialogItem[]>([]);
  const [toasts, setToasts] = useState<InternalToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setDialogs((prev) => [...prev, { id: nextId++, kind: "confirm", ...options, resolve }]);
    });
  }, []);

  const alert = useCallback((options: AlertOptions): Promise<void> => {
    return new Promise<void>((resolve) => {
      setDialogs((prev) => [...prev, { id: nextId++, kind: "alert", ...options, resolve }]);
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

  // The state updater must stay pure: React may drop or replay an updater
  // (and StrictMode invokes it twice), so resolving the promise inside it made
  // the caller's `await confirm(...)` depend on render internals.
  const dialogsRef = useRef<InternalDialogItem[]>([]);
  dialogsRef.current = dialogs;

  const closeDialog = useCallback((id: number, ok: boolean) => {
    const item = dialogsRef.current.find((d) => d.id === id);
    setDialogs((prev) => prev.filter((d) => d.id !== id));
    if (!item) return;
    if (item.kind === "confirm") item.resolve(ok);
    else item.resolve();
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
      // A pending dialog would otherwise hang its caller forever when the
      // provider unmounts (route change, HMR).
      dialogsRef.current.forEach((item) => {
        if (item.kind === "confirm") item.resolve(false);
        else item.resolve();
      });
    };
  }, []);

  return (
    <DialogsContext.Provider value={{ confirm, alert, toast }}>
      {children}
      <DialogStack items={dialogs} onClose={closeDialog} />
      <ToastStack items={toasts} />
    </DialogsContext.Provider>
  );
}

/**
 * Escape dismisses, and focus goes into the dialog when it opens and back to
 * whatever was focused before when it closes. Both were missing: the dialog was
 * mouse-only for keyboard users, and closing it dropped focus to `<body>`.
 */
function useDialogFocus(id: number, onEscape: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreRef.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [id, onEscape]);

  return panelRef;
}

function DialogStack({
  items,
  onClose,
}: {
  items: InternalDialogItem[];
  onClose: (id: number, ok: boolean) => void;
}) {
  if (items.length === 0) return null;
  const top = items[items.length - 1]!;
  const variant = top.variant ?? "default";
  const danger = variant === "danger";
  const isAlert = top.kind === "alert";
  const title = top.title ?? (isAlert ? "提示" : danger ? "确认操作" : "提示");
  const message = top.message;

  return (
    <>
      {items.slice(0, -1).map((c) => (
        <div key={c.id} className="pointer-events-none fixed inset-0 z-[100]" aria-hidden />
      ))}
      <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 px-4 backdrop-blur-sm">
        <DialogPanel
          id={top.id}
          isAlert={isAlert}
          danger={danger}
          title={title}
          message={message}
          closeLabel={top.kind === "alert" ? (top.buttonLabel ?? "知道了") : undefined}
          confirmLabel={top.kind === "confirm" ? (top.confirmLabel ?? (danger ? "确认" : "确定")) : undefined}
          cancelLabel={top.kind === "confirm" ? (top.cancelLabel ?? "取消") : undefined}
          onClose={(ok) => onClose(top.id, ok)}
        />
      </div>
    </>
  );
}

function DialogPanel({
  id,
  isAlert,
  danger,
  title,
  message,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onClose,
}: {
  id: number;
  isAlert: boolean;
  danger: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  closeLabel?: string;
  onClose: (ok: boolean) => void;
}) {
  const panelRef = useDialogFocus(id, () => onClose(false));
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Confirm starts on the *cancel* button (Enter must not fire the destructive
  // default); an alert has only one action, so it takes focus.
  useEffect(() => {
    (isAlert ? okRef : cancelRef).current?.focus();
  }, [isAlert]);

  const titleId = `dialog-title-${id}`;
  const descId = `dialog-desc-${id}`;

  return (
    <div
      ref={panelRef}
      role={isAlert ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      // Tab 焦点循环留在面板内（见 components/focus-trap.ts）。
      onKeyDown={(event) => trapFocusWithin(panelRef.current, event.nativeEvent)}
      className="w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--surface)] shadow-2xl"
    >
      <div className="flex items-start gap-3 p-5">
        <div
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
            danger
              ? "bg-[color-mix(in_srgb,var(--app-danger)_15%,var(--surface))] text-[var(--app-danger)]"
              : "bg-[color-mix(in_srgb,var(--color-primary)_12%,var(--surface))] text-[var(--color-primary)]"
          }`}
        >
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-base font-bold tracking-tight">
            {title}
          </h3>
          <p id={descId} className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[var(--color-muted)]">
            {message}
          </p>
        </div>
      </div>
      <div className="flex border-t border-[var(--color-edge-soft)]">
        {isAlert ? (
          <button
            ref={okRef}
            type="button"
            onClick={() => onClose(true)}
            className={`flex-1 py-3 text-sm font-bold transition-colors ${
              danger
                ? "text-[var(--app-danger)] hover:bg-[color-mix(in_srgb,var(--app-danger)_10%,var(--surface))]"
                : "text-[var(--color-primary)] hover:bg-black/5"
            }`}
          >
            {closeLabel}
          </button>
        ) : (
          <>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => onClose(false)}
              className="flex-1 border-r border-[var(--color-edge-soft)] py-3 text-sm font-semibold text-[var(--color-muted)] transition-colors hover:bg-black/5"
            >
              {cancelLabel}
            </button>
            <button
              ref={okRef}
              type="button"
              onClick={() => onClose(true)}
              className={`flex-1 py-3 text-sm font-bold transition-colors ${
                danger
                  ? "text-[var(--app-danger)] hover:bg-[color-mix(in_srgb,var(--app-danger)_10%,var(--surface))]"
                  : "text-[var(--color-primary)] hover:bg-black/5"
              }`}
            >
              {confirmLabel}
            </button>
          </>
        )}
      </div>
    </div>
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
  const [remainingMs, setRemainingMs] = useState(item.countdownMs ?? 0);

  useEffect(() => {
    if (!item.countdownMs) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, item.countdownMs! - (Date.now() - startedAt)));
    }, 250);
    return () => clearInterval(timer);
  }, [item.countdownMs]);
  const Icon = variant === "success" ? CheckCircle2 : variant === "error" ? X : Info;
  // Theme tokens, not `dark:` variants: the dark variant follows the OS scheme
  // while the rest of the app follows the selected DaisyUI theme, so on a
  // "light app on a dark OS" every toast was dark-on-light and vice versa.
  const border =
    variant === "success"
      ? "border-s-[3px] border-s-[var(--app-success)]"
      : variant === "error"
        ? "border-s-[3px] border-s-[var(--app-danger)]"
        : "border-s-[3px] border-s-[var(--app-info)]";
  const color = `border-[var(--color-edge)] bg-[var(--surface)] text-[var(--color-ink)] ${border}`;
  const iconColor =
    variant === "success"
      ? "text-[var(--app-success)]"
      : variant === "error"
        ? "text-[var(--app-danger)]"
        : "text-[var(--app-info)]";

  return (
    <div
      role="status"
      className={`pointer-events-auto flex min-w-[260px] max-w-md items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${color}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
      <span className="min-w-0 flex-1 break-words">{item.message}</span>
      {item.action ? (
        <button
          type="button"
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))]"
          onClick={() => void item.action?.onClick()}
        >
          {item.action.label}
          {item.countdownMs ? ` · ${Math.ceil(remainingMs / 1000)}s` : ""}
        </button>
      ) : null}
    </div>
  );
}

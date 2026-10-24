import { useState, type ReactNode } from "react";
import { useDialogs } from "./Dialogs";

export interface DeleteWithUndoProps {
  confirmMessage: string;
  onDelete: () => void | Promise<void>;
  onUndo: () => void | Promise<void>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * Shared destructive-action guard. The server owns the tombstone; this component
 * only turns a successful soft-delete into a ten-second reversible toast.
 */
export function DeleteWithUndo({
  confirmMessage,
  onDelete,
  onUndo,
  children,
  className,
  disabled = false,
}: DeleteWithUndoProps) {
  const { confirm, toast } = useDialogs();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    if (!(await confirm({ message: confirmMessage, variant: "danger", confirmLabel: "删除" }))) return;
    setBusy(true);
    try {
      await onDelete();
      let undone = false;
      toast({
        message: "已删除 · 10 秒内可撤销",
        variant: "success",
        durationMs: 10_000,
        countdownMs: 10_000,
        action: {
          label: "撤销",
          onClick: async () => {
            if (undone) return;
            undone = true;
            try {
              await onUndo();
              toast({ message: "已恢复", variant: "success" });
            } catch (error) {
              undone = false;
              toast({ message: error instanceof Error ? error.message : "撤销失败，请到回收站恢复", variant: "error" });
            }
          },
        },
      });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : "删除失败", variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" disabled={disabled || busy} className={className} onClick={() => void run()}>
      {busy ? "删除中…" : children}
    </button>
  );
}

import { useState } from "react";
import { Pencil } from "lucide-react";

/** 顶栏可点击改名的问卷标题（S2 从 EditorPage 抽出，两套壳共用）。 */
export function EditableTitle({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (!editing) {
    return (
      <button
        type="button"
        className="editor-title-edit"
        disabled={disabled}
        title={disabled ? undefined : "点击修改问卷标题"}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        <span className="truncate">{value}</span>
        {!disabled ? <Pencil className="editor-title-edit-icon h-3.5 w-3.5" /> : null}
      </button>
    );
  }

  return (
    <input
      autoFocus
      className="editor-title-input"
      value={draft}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
          setEditing(false);
        }
      }}
    />
  );
}

import { useState } from "react";
import type { EditorData } from "../../../api";
import type { useSurveyEditor } from "../../../editor/useSurveyEditor";
import type { useEditorActions } from "../../../editor/editor-actions";
import type { BuilderSelection } from "../StructureTree";
import { QuestionCard } from "../QuestionCard";
import { SurveySettingsPanel } from "../SurveySettingsPanel";
import { LogicPanel } from "../LogicPanel";

type Editor = ReturnType<typeof useSurveyEditor>;
type Actions = ReturnType<typeof useEditorActions>;

/**
 * P2 属性区（右栏）：选中即配置，不出现页面跳转。
 * 选中题目 → QuestionCard（与旧壳同一份卡片：头部 + QuestionForm）；
 * 选中问卷设置 → SurveySettingsPanel；专业模式追加「逻辑」页签（LogicPanel）。
 */
export function PropertiesPanel({
  data,
  editor,
  actions,
  selection,
  editable,
  editorMode,
  onSelect,
}: {
  data: EditorData;
  editor: Editor;
  actions: Actions;
  selection: BuilderSelection;
  editable: boolean;
  editorMode: "basic" | "pro";
  onSelect: (questionId: number) => void;
}) {
  // 属性 / 逻辑（逻辑仅专业模式可见，与旧壳右栏页签同一规则）。
  const [tab, setTab] = useState<"props" | "logic">("props");
  const showLogic = editorMode === "pro" && tab === "logic";
  const selectedQuestion =
    selection.kind === "question"
      ? (editor.questions.find((question) => question.id === selection.id) ?? null)
      : null;
  const selectedIndex = selectedQuestion ? editor.questions.indexOf(selectedQuestion) : -1;

  return (
    // 不自建滚动容器：.editor-preview 列本身就是滚动层（.editor-col）；
    // 专业模式的页签用 sticky 钉在栏顶。
    <div>
      {editorMode === "pro" ? (
        <div
          className="sticky top-0 z-10 flex gap-1 border-b border-[var(--color-edge)] px-2 pt-2"
          style={{ background: "var(--surface)" }}
        >
          {(
            [
              { id: "props", label: "属性" },
              { id: "logic", label: "逻辑" },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`rounded-t-lg px-3 py-1.5 text-[11px] font-semibold ${
                tab === entry.id ? "bg-[var(--surface)] text-[var(--color-ink)]" : "text-[var(--color-muted)]"
              }`}
              aria-pressed={tab === entry.id}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="p-3">
        {showLogic ? (
          <LogicPanel
            questions={editor.questions.map((question) => ({
              id: question.id,
              title: question.title,
              condition: question.condition,
            }))}
            selectedId={selection.kind === "question" ? selection.id : null}
            onSelect={onSelect}
          />
        ) : selection.kind === "settings" || !selectedQuestion ? (
          <SurveySettingsPanel
            surveyId={data.survey.id}
            questions={editor.questions}
            meta={editor.surveyMeta}
            disabled={!editable}
            coinAccess={data.coinAccess ?? { enabled: false, autoPrice: true, basePrice: 0, fixedPrice: null }}
            onUpdate={(patch) => editor.updateSurveyMeta(patch)}
          />
        ) : (
          <QuestionCard
            question={selectedQuestion}
            index={selectedIndex}
            editable={editable}
            editorMode={editorMode}
            onFieldCommit={(questionId, patch, label) => {
              if (Object.keys(patch).length) editor.queueQuestionPatch(questionId, patch, label);
            }}
            onLocalChange={editor.patchQuestionLocal}
            onOptionRename={(questionId, optionId, label) => editor.renameOption(questionId, optionId, label)}
            onAddOption={editor.addOption}
            onDeleteOption={editor.deleteOption}
            onDelete={(questionId) => void actions.requestDeleteQuestion(questionId)}
            onDuplicateQuestion={(questionId) => void actions.duplicateQuestion(questionId)}
            onDuplicateOption={(questionId, optionId) => void actions.duplicateOption(questionId, optionId)}
            onAttachQuestionMedia={(questionId, file) => actions.attachQuestionMedia(questionId, file)}
            onAttachQuestionMediaFromLibrary={(questionId, assetId) =>
              actions.attachQuestionMediaFromLibrary(questionId, assetId)
            }
            onRemoveQuestionMedia={(questionId, mediaAssetId) => actions.removeQuestionMedia(questionId, mediaAssetId)}
            onAttachOptionMedia={(optionId, file) => actions.attachOptionMedia(optionId, file)}
            onAttachOptionMediaFromLibrary={(optionId, assetId) =>
              actions.attachOptionMediaFromLibrary(optionId, assetId)
            }
            onRemoveOptionMedia={(optionId, mediaAssetId) => actions.removeOptionMedia(optionId, mediaAssetId)}
            onOpenSceneEditor={(questionId) => void actions.openSceneEditor(questionId)}
            allQuestions={editor.questions}
            pages={data.pages.map((page) => ({ id: page.id, title: page.title, order: page.order }))}
          />
        )}
      </div>
    </div>
  );
}

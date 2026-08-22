import { useEffect, useId } from 'react';
import { QUESTION_TYPE_LABELS } from '../../format';
import type { EditorPreviewQuestion } from '../../editor/previewModel';
import {
  getMatrixColumns,
  getQuestionInstruction,
  isSingleChoiceQuestion,
} from '../../../../src/survey/question-presentation';

interface SurveyPreviewProps {
  title: string;
  description: string;
  questions: EditorPreviewQuestion[];
  dirty: boolean;
  onClose: () => void;
}

function PreviewChoice({ label, multiple, mediaCount }: { label: string; multiple: boolean; mediaCount: number }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm">
      <span aria-hidden="true" className="text-gray-400">
        {multiple ? '☐' : '○'}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {mediaCount ? <span className="text-xs text-purple-600">📎 ×{mediaCount}</span> : null}
    </div>
  );
}

function PreviewAnswer({ question }: { question: EditorPreviewQuestion }) {
  if (isSingleChoiceQuestion(question) || question.type === 'multiple') {
    return (
      <div className="grid gap-2">
        {question.options.map((option) => (
          <PreviewChoice
            key={option.id}
            label={option.label}
            multiple={question.type === 'multiple'}
            mediaCount={question.optionMediaById.get(option.id)?.length ?? 0}
          />
        ))}
        {question.type === 'multiple' ? (
          <button type="button" className="btn btn-sm" disabled>
            完成选择
          </button>
        ) : null}
      </div>
    );
  }

  if (question.type === 'matrix') {
    const columns = getMatrixColumns(question);
    return (
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full min-w-[440px] border-collapse text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">行</th>
              {columns.map((column, index) => (
                <th key={`${column}-${index}`} className="px-3 py-2 text-center font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {question.options.map((option) => (
              <tr key={option.id} className="border-t border-gray-100">
                <td className="px-3 py-2">{option.label}</td>
                {columns.map((column, index) => (
                  <td key={`${column}-${index}`} className="px-3 py-2 text-center text-gray-300">
                    ○
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (question.type === 'long_text') {
    return <textarea className="input min-h-24 w-full" disabled placeholder="在 Telegram 中输入回答" />;
  }
  if (question.type === 'number') {
    return <input className="input w-full" type="number" disabled placeholder="输入数字" />;
  }
  if (question.type === 'date' || question.type === 'time') {
    return <input className="input w-full" type={question.type} disabled />;
  }
  if (['image', 'video', 'audio', 'file'].includes(question.type)) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-sm text-gray-500">
        {question.media.length ? `已配置 ${question.media.length} 个题目附件` : '请在 Telegram 中发送对应媒体文件'}
      </div>
    );
  }
  return <input className="input w-full" disabled placeholder="在 Telegram 中输入回答" />;
}

export function SurveyPreview({ title, description, questions, dirty, onClose }: SurveyPreviewProps) {
  const titleId = useId();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/45 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[100dvh] w-full max-w-3xl flex-col bg-page shadow-xl sm:max-h-[90dvh] sm:rounded-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white p-4 sm:rounded-t-xl">
          <div>
            <h2 id={titleId} className="font-semibold">
              问卷填写预览
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {dirty ? '包含尚未保存的本地修改' : '当前已保存版本'} · Telegram 实际填写时每次显示一题
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose} autoFocus>
            ✕ 关闭
          </button>
        </header>

        <div className="overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-xl">
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <h3 className="text-xl font-bold">{title || '未命名问卷'}</h3>
              {description ? <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{description}</p> : null}
              <p className="mt-3 text-xs text-gray-400">共 {questions.length} 题</p>
            </div>

            {questions.length ? (
              <div className="mt-4 grid gap-4">
                {questions.map((question, index) => (
                  <article key={question.id} className="rounded-xl bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-blue-600">
                        第 {index + 1} / {questions.length} 题
                      </span>
                      <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">
                        {QUESTION_TYPE_LABELS[question.type] ?? question.type}
                      </span>
                      <span className={question.required ? 'text-red-600' : 'text-gray-400'}>
                        {question.required ? '必答' : '选答'}
                      </span>
                    </div>
                    <h4 className="mt-3 font-semibold">{question.title || '未填写题目标题'}</h4>
                    {question.description ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-gray-500">{question.description}</p>
                    ) : null}
                    {question.media.length ? (
                      <div className="mt-3 rounded-lg bg-purple-50 p-3 text-xs text-purple-700">
                        题目媒体附件 ×{question.media.length}（Web 预览仅展示引用状态）
                      </div>
                    ) : null}
                    <p className="my-3 text-sm text-gray-500">{getQuestionInstruction(question)}</p>
                    <PreviewAnswer question={question} />
                    <div className="mt-3 flex gap-2 border-t border-gray-100 pt-3">
                      {index > 0 ? <span className="btn btn-sm flex-1 text-center">⬅️ 上一题</span> : null}
                      <span className="btn btn-sm flex-1 text-center">
                        {index === questions.length - 1 ? '✅ 提交' : '下一题 ➡️'}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
                问卷尚无题目
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { EditableQuestion } from '../../editor/useSurveyEditor';
import { QuestionCard } from './QuestionCard';

interface SortableQuestionListProps {
  questions: EditableQuestion[];
  editable: boolean;
  onReorder: (questionIds: number[]) => void;
  onFieldCommit: (questionId: number, patch: Record<string, unknown>, label: string) => void;
  onLocalChange: (questionId: number, patch: Partial<EditableQuestion>) => void;
  onOptionRename: (questionId: number, optionId: number, label: string) => void;
  onAddOption: (questionId: number, label: string) => void;
  onDeleteOption: (questionId: number, optionId: number) => void;
  onDelete: (questionId: number) => void;
  onDuplicateQuestion: (questionId: number) => void;
  onDuplicateOption: (questionId: number, optionId: number) => void;
  pages?: Array<{ id: number; title: string | null; order: number }>;
}

function SortableQuestionCard({
  question,
  index,
  editable,
  disabled,
  allQuestions,
  pages,
  ...questionCardProps
}: Omit<SortableQuestionListProps, 'questions' | 'onReorder' | 'editable'> & {
  question: EditableQuestion;
  index: number;
  editable: boolean;
  disabled: boolean;
  allQuestions: EditableQuestion[];
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: question.id,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.72 : 1,
      }}
    >
      <QuestionCard
        question={question}
        index={index}
        editable={editable}
        allQuestions={allQuestions}
        pages={pages}
        dragHandle={
          <button
            ref={setActivatorNodeRef}
            type="button"
            className="drag-handle"
            aria-label={`拖动第 ${index + 1} 题排序`}
            title="拖动排序；移动端请长按"
            disabled={disabled}
            {...attributes}
            {...listeners}
          >
            <span aria-hidden="true">⠿</span>
          </button>
        }
        {...questionCardProps}
      />
    </div>
  );
}

export function SortableQuestionList({
  questions,
  editable,
  onReorder,
  pages,
  ...questionCardProps
}: SortableQuestionListProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const questionIds = questions.map((question) => question.id);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const oldIndex = questionIds.indexOf(Number(active.id));
    const newIndex = questionIds.indexOf(Number(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(questionIds, oldIndex, newIndex));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={questionIds} strategy={verticalListSortingStrategy}>
        <div className="grid gap-3">
          {questions.map((question, index) => (
            <SortableQuestionCard
              key={question.id}
              question={question}
              index={index}
              editable={editable}
              disabled={!editable || questions.length < 2}
              allQuestions={questions}
              pages={pages}
              {...questionCardProps}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, Save, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { apiSend } from "../../api";

type Question = { id: number; type: string; title: string; options: Array<{ id: number; label: string }> };
type Scoring = { questionId: number; values: Record<string, number>; defaultScore?: number };
type Dimension = { id: string; label: string; description?: string | null; min?: number; max?: number; scoring: Scoring[] };
type ResultType = { id: string; label: string; title?: string | null; subtitle?: string | null; description?: string | null; tags?: string[]; image?: string | null; minScore?: number; maxScore?: number };
type RuleSet = { schemaVersion: number; defaults?: Record<string, unknown>; dimensions: Dimension[]; resultTypes: ResultType[]; rules: Array<Record<string, unknown>> };

type Preview = { dimensions: Array<Dimension & { value: number; maxValue: number; answered: number }>; total: number; maxTotal: number; matched: ResultType | null };

const emptyRuleSet = (): RuleSet => ({
  schemaVersion: 1,
  defaults: { resultType: "custom", title: "我的问卷结果", subtitle: "根据你的回答生成的个人结果。" },
  dimensions: [], resultTypes: [], rules: [],
});

function normalizeRuleSet(value: unknown): RuleSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRuleSet();
  const raw = value as Record<string, unknown>;
  return {
    schemaVersion: 1,
    defaults: raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults) ? raw.defaults as Record<string, unknown> : {},
    dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.map((d) => ({ ...(d as Dimension), scoring: Array.isArray((d as Dimension).scoring) ? (d as Dimension).scoring : [] })) : [],
    resultTypes: Array.isArray(raw.resultTypes) ? raw.resultTypes as ResultType[] : [],
    rules: Array.isArray(raw.rules) ? raw.rules as Array<Record<string, unknown>> : [],
  };
}

function buildPreview(ruleSet: RuleSet, questions: Question[], answers: Record<number, string | string[]>): Preview {
  const dimensions = ruleSet.dimensions.map((dimension) => {
    let value = 0; let answered = 0;
    for (const scoring of dimension.scoring) {
      const raw = answers[scoring.questionId];
      if (raw === undefined || raw === "") continue;
      const selected = Array.isArray(raw) ? raw : [raw];
      for (const answer of selected) {
        answered += 1;
        value += scoring.values[answer] ?? scoring.defaultScore ?? 0;
      }
    }
    const maxValue = Number.isFinite(dimension.max) ? Number(dimension.max) : 100;
    return { ...dimension, value, maxValue, answered };
  });
  const total = dimensions.reduce((sum, item) => sum + item.value, 0);
  const maxTotal = dimensions.reduce((sum, item) => sum + item.maxValue, 0);
  const matched = ruleSet.resultTypes.find((type) => (type.minScore === undefined || total >= type.minScore) && (type.maxScore === undefined || total <= type.maxScore)) ?? null;
  return { dimensions, total, maxTotal, matched };
}

export function ResultRulesPanel({ surveyId, questions, disabled = false }: { surveyId: number; questions: Question[]; disabled?: boolean }) {
  const [ruleSet, setRuleSet] = useState<RuleSet>(emptyRuleSet);
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch(`/api/admin/surveys/${surveyId}/result-rules`, { credentials: "include" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("读取结果规则失败")))
      .then((payload: { ruleSet?: unknown }) => { if (active) setRuleSet(normalizeRuleSet(payload.ruleSet)); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "读取结果规则失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [surveyId]);
  const choiceQuestions = useMemo(() => questions.filter((q) => ["single", "multiple", "yes_no", "rating"].includes(q.type)), [questions]);
  const preview = useMemo(() => buildPreview(ruleSet, choiceQuestions, answers), [ruleSet, choiceQuestions, answers]);
  const totalConfiguredMax = preview.maxTotal;

  const save = async () => {
    setSaving(true); setMessage(null);
    try { await apiSend("PUT", `/api/admin/surveys/${surveyId}/result-rules`, { ruleSet }); setMessage("结果规则已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="settings-panel"><div className="settings-panel-sub">正在加载结果规则…</div></div>;
  return (
    <div className="settings-panel result-rules-panel">
      <div className="result-rules-head"><div><div className="settings-panel-title"><Sparkles size={16} />结果设计器</div><div className="settings-panel-sub">配置维度、题目计分和结果区间；右侧预览会随着测试答案立即计算。</div></div><button type="button" className="btn btn-primary" disabled={disabled || saving} onClick={() => void save()}><Save size={14} />{saving ? "保存中…" : "保存规则"}</button></div>
      {message ? <div className="alert alert-info">{message}</div> : null}
      <div className="result-designer-grid">
        <div className="result-rule-config">
          <DimensionEditor dimensions={ruleSet.dimensions} questions={choiceQuestions} disabled={disabled} onChange={(dimensions) => setRuleSet((s) => ({ ...s, dimensions }))} />
          <ResultTypeEditor types={ruleSet.resultTypes} totalMax={totalConfiguredMax} disabled={disabled} onChange={(resultTypes) => setRuleSet((s) => ({ ...s, resultTypes }))} />
        </div>
        <ResultPreview questions={choiceQuestions} answers={answers} preview={preview} types={ruleSet.resultTypes} disabled={disabled} onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))} onReset={() => setAnswers({})} />
      </div>
    </div>
  );
}
function DimensionEditor({ dimensions, questions, disabled, onChange }: { dimensions: Dimension[]; questions: Question[]; disabled: boolean; onChange: (v: Dimension[]) => void }) {
  const add = () => onChange([...dimensions, { id: `dimension_${Date.now()}`, label: `新维度 ${dimensions.length + 1}`, min: 0, max: 100, scoring: [] }]);
  const update = (index: number, patch: Partial<Dimension>) => onChange(dimensions.map((d, i) => i === index ? { ...d, ...patch } : d));
  return <section className="result-rule-section"><div className="result-rule-title"><div><strong>评分维度</strong><span>题目 → 维度 → 分数 → 结果</span></div><button type="button" className="btn btn-secondary" disabled={disabled} onClick={add}><Plus size={14}/>添加维度</button></div>
    {dimensions.map((dimension, index) => <DimensionCard key={dimension.id} dimension={dimension} questions={questions} disabled={disabled} onChange={(v) => update(index, v)} onRemove={() => onChange(dimensions.filter((_, i) => i !== index))} />)}
    {!dimensions.length ? <div className="result-rule-empty">还没有评分维度。添加后，把选择题/评分题分配进来。</div> : null}</section>;
}

function DimensionCard({ dimension, questions, disabled, onChange, onRemove }: { dimension: Dimension; questions: Question[]; disabled: boolean; onChange: (v: Partial<Dimension>) => void; onRemove: () => void }) {
  const addQuestion = (questionId: number) => {
    if (!questionId || dimension.scoring.some((s) => s.questionId === questionId)) return;
    onChange({ scoring: [...dimension.scoring, { questionId, values: {} }] });
  };
  const setScore = (questionId: number, label: string, score: number) => onChange({ scoring: dimension.scoring.map((s) => s.questionId === questionId ? { ...s, values: { ...s.values, [label]: Number.isFinite(score) ? score : 0 } } : s) });
  return <div className="result-rule-card">
    <div className="result-rule-card-head"><div className="result-dimension-name"><input className="settings-input" value={dimension.label} disabled={disabled} onChange={(e) => onChange({ label: e.target.value })}/><span>{dimension.scoring.length} 个影响题</span></div><button type="button" className="icon-button danger" disabled={disabled} onClick={onRemove} aria-label="删除维度"><Trash2 size={14}/></button></div>
    <div className="result-rule-grid"><label><span className="q-label">最小分</span><input className="settings-input" type="number" value={dimension.min ?? 0} disabled={disabled} onChange={(e) => onChange({ min: Number(e.target.value) })}/></label><label><span className="q-label">最大分</span><input className="settings-input" type="number" value={dimension.max ?? 100} disabled={disabled} onChange={(e) => onChange({ max: Number(e.target.value) })}/></label></div>
    {dimension.scoring.map((scoring) => <QuestionScoring key={scoring.questionId} scoring={scoring} question={questions.find((q) => q.id === scoring.questionId)} disabled={disabled} onScore={(label, score) => setScore(scoring.questionId, label, score)} onRemove={() => onChange({ scoring: dimension.scoring.filter((s) => s.questionId !== scoring.questionId) })} />)}
    <select className="settings-input" disabled={disabled} value="" onChange={(e) => addQuestion(Number(e.target.value))}><option value="">＋ 添加影响此维度的题目</option>{questions.filter((q) => !dimension.scoring.some((s) => s.questionId === q.id)).map((q) => <option key={q.id} value={q.id}>第 {questions.indexOf(q) + 1} 题 · {q.title}</option>)}</select>
  </div>;
}
function QuestionScoring({ scoring, question, disabled, onScore, onRemove }: { scoring: Scoring; question?: Question; disabled: boolean; onScore: (label: string, score: number) => void; onRemove: () => void }) {
  if (!question) return <div className="alert alert-warning">题目 #{scoring.questionId} 已不存在，请移除该规则。</div>;
  const options = question.options.length ? question.options : Array.from({ length: 5 }, (_, i) => ({ id: i, label: String(i + 1) }));
  return <div className="result-scoring"><div className="result-scoring-head"><span>第 {question.id} 题 · {question.title}</span><button type="button" className="text-button danger" disabled={disabled} onClick={onRemove}>移除</button></div><div className="result-score-options">{options.map((option) => <label key={option.id}><span>{option.label}</span><input type="number" step="1" value={scoring.values[option.label] ?? 0} disabled={disabled} onChange={(e) => onScore(option.label, Number(e.target.value))}/></label>)}</div></div>;
}

function ResultTypeEditor({ types, totalMax, disabled, onChange }: { types: ResultType[]; totalMax: number; disabled: boolean; onChange: (v: ResultType[]) => void }) {
  const add = () => onChange([...types, { id: `result_${Date.now()}`, label: `结果 ${types.length + 1}`, minScore: 0, maxScore: totalMax || 100 }]);
  const update = (index: number, patch: Partial<ResultType>) => onChange(types.map((t, i) => i === index ? { ...t, ...patch } : t));
  return <section className="result-rule-section"><div className="result-rule-title"><div><strong>最终结果</strong><span>按所有维度总分匹配；当前配置最大总分 {totalMax}</span></div><button type="button" className="btn btn-secondary" disabled={disabled} onClick={add}><Plus size={14}/>添加结果</button></div>
    {types.map((type, index) => <div className="result-type-card" key={type.id}><div className="result-rule-grid"><label><span className="q-label">结果名称</span><input className="settings-input" value={type.label} disabled={disabled} onChange={(e) => update(index, { label: e.target.value })}/></label><label><span className="q-label">ID</span><input className="settings-input" value={type.id} disabled={disabled} onChange={(e) => update(index, { id: e.target.value.replace(/[^A-Za-z0-9_-]/g, "_") })}/></label><label><span className="q-label">最低总分</span><input className="settings-input" type="number" value={type.minScore ?? 0} disabled={disabled} onChange={(e) => update(index, { minScore: Number(e.target.value) })}/></label><label><span className="q-label">最高总分</span><input className="settings-input" type="number" value={type.maxScore ?? totalMax} disabled={disabled} onChange={(e) => update(index, { maxScore: Number(e.target.value) })}/></label></div>
      <label className="settings-field"><span className="q-label">结果标题</span><input className="settings-input" value={type.title ?? ""} disabled={disabled} onChange={(e) => update(index, { title: e.target.value })}/></label>
      <label className="settings-field"><span className="q-label">结果文案</span><textarea className="settings-input" rows={3} value={type.subtitle ?? ""} disabled={disabled} onChange={(e) => update(index, { subtitle: e.target.value })}/></label>
      <label className="settings-field"><span className="q-label">标签</span><input className="settings-input" value={(type.tags ?? []).join(", ")} disabled={disabled} onChange={(e) => update(index, { tags: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}/></label>
      <label className="settings-field"><span className="q-label">结果图片 URL</span><input className="settings-input" value={type.image ?? ""} disabled={disabled} onChange={(e) => update(index, { image: e.target.value || null })}/></label>
      <button type="button" className="text-button danger" disabled={disabled} onClick={() => onChange(types.filter((_, i) => i !== index))}>删除结果</button>
    </div>)}
    {!types.length ? <div className="result-rule-empty">没有结果类型时，只显示维度分数；添加结果后才能得到明确的最终类型。</div> : null}</section>;
}
function ResultPreview({ questions, answers, preview, types, disabled, onAnswer, onReset }: { questions: Question[]; answers: Record<number, string | string[]>; preview: Preview; types: ResultType[]; disabled: boolean; onAnswer: (id: number, value: string | string[]) => void; onReset: () => void }) {
  const influencingIds = new Set(preview.dimensions.flatMap((d) => d.scoring.map((s) => s.questionId)));
  const testQuestions = questions.filter((q) => influencingIds.has(q.id));
  return <aside className="result-preview-card">
    <div className="result-preview-head"><div><strong><Sparkles size={15}/>实时结果预览</strong><span>仅用于调试，不会写入真实答卷</span></div><button type="button" className="text-button" disabled={disabled || !Object.keys(answers).length} onClick={onReset}>清空答案</button></div>
    <div className="result-preview-body">
      <div className="result-preview-answer-title">测试答案</div>
      {!testQuestions.length ? <div className="result-rule-empty">先在左侧把题目加入评分维度，这里就会出现可模拟的答案。</div> : null}
      {testQuestions.map((question) => <PreviewQuestion key={question.id} question={question} value={answers[question.id]} disabled={disabled} onChange={(value) => onAnswer(question.id, value)} />)}
      <div className="result-preview-total"><div><span>最终总分</span><strong>{preview.total}<small> / {preview.maxTotal || 0}</small></strong></div><div className="result-preview-total-bar"><i style={{ width: `${preview.maxTotal ? Math.max(0, Math.min(100, preview.total / preview.maxTotal * 100)) : 0}%` }}/></div></div>
      <div className="result-preview-answer-title">最终结果</div>
      {preview.matched ? <div className="result-match"><CheckCircle2 size={20}/><div><strong>{preview.matched.title ?? preview.matched.label}</strong><span>{preview.matched.minScore ?? 0} – {preview.matched.maxScore ?? "∞"} 分 · ID {preview.matched.id}</span></div></div> : <div className="result-no-match"><TriangleAlert size={18}/><div><strong>没有匹配结果</strong><span>当前总分 {preview.total} 不在任何结果区间内。</span></div></div>}
      {preview.matched?.subtitle ? <p className="result-preview-copy">{preview.matched.subtitle}</p> : null}
      {preview.matched?.tags?.length ? <div className="result-preview-tags">{preview.matched.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      <div className="result-preview-answer-title">维度明细</div>
      {preview.dimensions.map((dimension) => <div className="result-dimension-preview" key={dimension.id}><div><span>{dimension.label}</span><strong>{dimension.value} / {dimension.maxValue}</strong></div><div className="result-preview-total-bar"><i style={{ width: `${dimension.maxValue ? Math.max(0, Math.min(100, dimension.value / dimension.maxValue * 100)) : 0}%` }}/></div><small>{dimension.answered ? `${dimension.answered} 个答案参与计分` : "尚未选择答案"}</small></div>)}
      {types.length > 0 && preview.matched ? <div className="result-preview-reason">为什么匹配：总分 <b>{preview.total}</b> 落在「{preview.matched.label}」的 <b>{preview.matched.minScore ?? 0}–{preview.matched.maxScore ?? "∞"}</b> 区间内。</div> : null}
    </div>
  </aside>;
}
function PreviewQuestion({ question, value, disabled, onChange }: { question: Question; value: string | string[] | undefined; disabled: boolean; onChange: (value: string | string[]) => void }) {
  const options = question.options.length ? question.options : Array.from({ length: 5 }, (_, i) => ({ id: i, label: String(i + 1) }));
  if (question.type === "multiple") {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    return <div className="result-preview-question"><span>第 {question.id} 题 · {question.title}</span><div className="result-preview-options">{options.map((option) => <label key={option.id}><input type="checkbox" checked={selected.includes(option.label)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...selected, option.label] : selected.filter((item) => item !== option.label))}/>{option.label}</label>)}</div></div>;
  }
  return <label className="result-preview-question"><span>第 {question.id} 题 · {question.title}</span><select className="settings-input" value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}><option value="">未选择</option>{options.map((option) => <option key={option.id} value={option.label}>{option.label}</option>)}</select></label>;
}

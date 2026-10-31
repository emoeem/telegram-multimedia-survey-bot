import { useEffect, useState } from "react";
import { ApiError, apiSend, generateResultPool } from "../../api";
import { useApi } from "../../hooks";
import type { SurveyMetaState } from "../../editor/useSurveyEditor";
import { ResultRulesPanel } from "./ResultRulesPanel";
import {
  SURVEY_DISPLAY_MODES,
  SURVEY_DISPLAY_MODE_LABELS,
  type SurveyDisplayMode,
} from "../../../../src/survey/display";

/**
 * 问卷设置面板（S2 从 EditorPage 抽出，两套壳共用）：
 * 标题/描述、报告模板、金币解锁、结局奖池、结果规则、匿名/18+/重复填写。
 *
 * 2026-10-31：结果设计器从「无条件全展开」改为**折叠入口**——它是为整页宽
 * 设计的复合面板（双列 + sticky 预览），塞进 360px 右栏时内层网格硬下限会把
 * 配置列压成 0 宽（文字逐字竖排）。入口卡默认收起，点开才渲染面板；
 * 基础模式（proMode=false）展开后只显示引导，不渲染编辑器。
 */
export function SurveySettingsPanel({
  surveyId,
  questions,
  meta,
  disabled,
  coinAccess,
  display,
  proMode = false,
  onUpdate,
}: {
  surveyId: number;
  questions: Array<{ id: number; type: string; title: string; options: Array<{ id: number; label: string }> }>;
  meta: SurveyMetaState;
  disabled: boolean;
  coinAccess: { enabled: boolean; autoPrice: boolean; basePrice: number; fixedPrice: number | null };
  /** 当前显示模式（settings_json.display）；设置面板里独立保存，不走 meta 队列。 */
  display: SurveyDisplayMode;
  /** 专业模式才渲染结果设计器本体；基础模式显示升级引导（与旧壳注释承诺一致）。 */
  proMode?: boolean;
  onUpdate: (patch: Partial<SurveyMetaState>) => void;
}) {
  const [rulesOpen, setRulesOpen] = useState(false);
  return (
    <div className="settings-panel">
      <div>
        <div className="settings-panel-title">问卷设置</div>
        <div className="settings-panel-sub">标题、描述与填写规则会应用到整个问卷</div>
      </div>

      <label className="settings-field">
        <span className="q-label">标题</span>
        <input
          className="settings-input"
          value={meta.title}
          disabled={disabled}
          placeholder="问卷标题"
          onChange={(event) => {
            const next = event.target.value;
            if (next !== meta.title) onUpdate({ title: next });
          }}
        />
      </label>

      <label className="settings-field">
        <span className="q-label">描述</span>
        <input
          className="settings-input"
          value={meta.description}
          disabled={disabled}
          placeholder="给答题者的整体说明（可选）"
          onChange={(event) => {
            const next = event.target.value;
            if (next !== meta.description) onUpdate({ description: next });
          }}
        />
      </label>

      <ReportTemplateSetting
        value={meta.reportTemplateId}
        disabled={disabled}
        onChange={(value) => onUpdate({ reportTemplateId: value })}
      />

      <CoinAccessSetting surveyId={surveyId} initial={coinAccess} disabled={disabled} />

      {rulesOpen && proMode ? (
        <ResultRulesPanel surveyId={surveyId} questions={questions} disabled={disabled} />
      ) : (
        <button
          type="button"
          className="result-rules-entry"
          aria-expanded={rulesOpen && proMode}
          onClick={() => setRulesOpen((open) => !open)}
        >
          <span className="result-rules-entry-icon" aria-hidden="true">
            📊
          </span>
          <span className="result-rules-entry-text">
            <strong>结果设计器</strong>
            <small>{proMode ? "评分维度 · 分数区间 · 结果文案" : "评分与结果区间配置（专业模式可用）"}</small>
          </span>
          <span className="result-rules-entry-action">{rulesOpen ? "收起" : "打开"}</span>
        </button>
      )}

      <ResultPoolGenerator surveyId={surveyId} disabled={disabled} />

      <DisplayModeSetting surveyId={surveyId} initial={display} disabled={disabled} />

      <div className="settings-check">
        <div>
          <div className="q-label">匿名填写</div>
          <div className="q-help">开启后不记录答题者的 Telegram 身份</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={meta.anonymous}
          aria-label="匿名填写"
          className="switch"
          data-on={meta.anonymous}
          disabled={disabled}
          onClick={() => onUpdate({ anonymous: !meta.anonymous })}
        />
      </div>

      <div className="settings-check">
        <div>
          <div className="q-label">18+ 内容</div>
          <div className="q-help">开启后问卷仅在目录/广场/展示区对已确认年龄的访问者可见，分享预览走安全卡片</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={meta.contentRating === "r18"}
          aria-label="18+ 内容"
          className="switch"
          data-on={meta.contentRating === "r18"}
          disabled={disabled}
          onClick={() => onUpdate({ contentRating: meta.contentRating === "r18" ? "all" : "r18" })}
        />
      </div>

      <div className="settings-check">
        <div>
          <div className="q-label">允许重复填写</div>
          <div className="q-help">同一用户可多次提交本问卷</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={meta.allowMultipleResponses}
          aria-label="允许重复填写"
          className="switch"
          data-on={meta.allowMultipleResponses}
          disabled={disabled}
          onClick={() => onUpdate({ allowMultipleResponses: !meta.allowMultipleResponses })}
        />
      </div>

      {meta.allowMultipleResponses ? (
        <label className="settings-field">
          <span className="q-label">每人填写上限（0 = 不限）</span>
          <input
            type="number"
            min={0}
            max={999}
            className="settings-input"
            defaultValue={meta.maxResponsesPerUser}
            disabled={disabled}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next !== meta.maxResponsesPerUser) {
                onUpdate({ maxResponsesPerUser: next });
              }
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

/**
 * 结局收集生成器（P1）：把结果设计里的 resultTypes 一键变成抽卡奖池的
 * 第一方结局卡。池子默认草稿态，价格与上下架在「社区 → 抽卡」管理页调整。
 */
function ResultPoolGenerator({ surveyId, disabled }: { surveyId: number; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await generateResultPool(surveyId, 20);
      setMessage(`已生成结局奖池（${result.items} 张结局卡，草稿态）——到「社区 → 抽卡」调整价格并上架。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "生成失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-check">
      <div>
        <div className="q-label">结局收集奖池</div>
        <div className="q-help">把「结果设计」里的结局变成抽卡内容：读者完成答卷后花金币抽取结局卡</div>
        {message ? <div className="q-help mt-1 text-[var(--app-success)]">{message}</div> : null}
        {error ? <div className="q-help mt-1 text-[var(--app-danger)]">{error}</div> : null}
      </div>
      <button type="button" className="btn btn-sm" disabled={disabled || busy} onClick={generate}>
        {busy ? "生成中…" : "生成结局奖池"}
      </button>
    </div>
  );
}

/**
 * 作者侧「金币解锁」配置卡片。金币解锁与密码访问互相独立：这里开启后，
 * 未解锁的访问者需要支付金币才能看到题目；密码问卷仍需输入密码。
 * 关闭只停用，不会删除任何已产生的解锁记录（已解锁者继续有效）。
 */
function CoinAccessSetting({
  surveyId,
  initial,
  disabled,
}: {
  surveyId: number;
  initial: { enabled: boolean; autoPrice: boolean; basePrice: number; fixedPrice: number | null };
  disabled: boolean;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(initial);
  }, [initial]);

  const save = async (next: typeof state) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiSend("PUT", `/api/admin/surveys/${surveyId}/coin-access`, {
        enabled: next.enabled,
        autoPrice: next.autoPrice,
        basePrice: next.basePrice,
        fixedPrice: next.autoPrice ? null : next.fixedPrice,
      });
      setState(next);
      setMessage("已保存。价格在问卷公开页对访问者展示，热度变动会按配置自动调整。");
      window.setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-check-block">
      <div className="settings-check">
        <div>
          <div className="q-label">金币解锁</div>
          <div className="q-help">
            开启后访问者需支付金币解锁本题问卷；免费问卷与密码问卷保持原样，密码仍需单独输入。
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.enabled}
          aria-label="金币解锁"
          className="switch"
          data-on={state.enabled}
          disabled={disabled || busy}
          onClick={() => void save({ ...state, enabled: !state.enabled })}
        />
      </div>
      {state.enabled ? (
        <div className="settings-coin-fields">
          <label className="settings-field">
            <span className="q-label">定价方式</span>
            <select
              className="settings-input"
              value={state.autoPrice ? "auto" : "fixed"}
              disabled={disabled || busy}
              onChange={(event) => void save({ ...state, autoPrice: event.target.value === "auto" })}
            >
              <option value="auto">按热度自动定价（推荐）</option>
              <option value="fixed">固定价格</option>
            </select>
          </label>
          {state.autoPrice ? (
            <label className="settings-field">
              <span className="q-label">基础价格（金币）</span>
              <input
                type="number"
                min={1}
                className="settings-input"
                defaultValue={state.basePrice}
                disabled={disabled || busy}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next > 0 && next !== state.basePrice) {
                    void save({ ...state, basePrice: next });
                  }
                }}
              />
              <span className="q-help">实际价格 = 基础价 × 热度系数，受平台最低/最高价约束。</span>
            </label>
          ) : (
            <label className="settings-field">
              <span className="q-label">固定价格（金币，0 = 限时免费）</span>
              <input
                type="number"
                min={0}
                className="settings-input"
                defaultValue={state.fixedPrice ?? 0}
                disabled={disabled || busy}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isInteger(next) && next >= 0 && next !== state.fixedPrice) {
                    void save({ ...state, fixedPrice: next });
                  }
                }}
              />
              <span className="q-help">固定价格不受热度影响；填 0 表示活动期免费开放。</span>
            </label>
          )}
        </div>
      ) : null}
      {message ? <div className="q-help settings-coin-ok">{message}</div> : null}
      {error ? <div className="q-help settings-coin-error">{error}</div> : null}
    </div>
  );
}

function ReportTemplateSetting({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const { data } = useApi<{ templates: Array<{ id: string; name: string; isCustom?: boolean }> }>(
    "/api/admin/report-templates",
  );
  return (
    <label className="settings-field">
      <span className="q-label">填写后报告模板</span>
      <select
        className="settings-input"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">平台默认</option>
        {(data?.templates ?? []).map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
            {template.isCustom ? " · 自定义" : ""}
          </option>
        ))}
      </select>
      <span className="q-help">发布后，填写者看到的个人结果报告会使用这里指定的模板。</span>
    </label>
  );
}

/**
 * 显示模式（settings_json.display）：auto / immersive / landscape。
 *
 * 独立立即保存（与金币解锁同一模式），不进 meta 的待保存队列——显示模式
 * 是版式取向，改完立刻想看到效果，跟着标题打字一起排队反而绕。
 * 文案与答题端行为一一对应，见 src/survey/display.ts。
 */
function DisplayModeSetting({
  surveyId,
  initial,
  disabled,
}: {
  surveyId: number;
  initial: SurveyDisplayMode;
  disabled: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const save = async (next: SurveyDisplayMode) => {
    if (next === value || busy) return;
    const previous = value;
    setValue(next); // 乐观更新：失败回滚
    setBusy(true);
    setError(null);
    try {
      await apiSend("PATCH", `/api/admin/surveys/${surveyId}`, { display: next });
    } catch (err) {
      setValue(previous);
      setError(err instanceof ApiError ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-check-block">
      <div>
        <div className="q-label">显示模式</div>
        <div className="q-help">决定答题页在电脑与手机上的版式；随时可改，立即生效。</div>
      </div>
      <div className="mt-2 grid gap-2" role="radiogroup" aria-label="显示模式">
        {SURVEY_DISPLAY_MODES.map((mode) => {
          const { title, hint } = SURVEY_DISPLAY_MODE_LABELS[mode];
          const active = value === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || busy}
              onClick={() => void save(mode)}
              className={`rounded-control border px-3 py-2 text-left text-xs transition ${
                active
                  ? "border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--surface))]"
                  : "border-[var(--color-edge)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              <div className="font-semibold">{title}</div>
              <div className="mt-0.5 text-[var(--color-muted)]">{hint}</div>
            </button>
          );
        })}
      </div>
      {error ? (
        <div className="mt-1 text-xs text-[var(--app-danger)]" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

import { TriangleAlert } from "lucide-react";

import { TRIAL_ADULT_CONFIRM_LABEL, trialAdultNoticeLines } from "./trial-adult-ack";

/**
 * 18+ 包级确认门卡片（修复 3：徽标与门同源——三处确认文案统一）。
 *
 * /s 内嵌玩法（GamePlayer / PluginGamePlay）共用的同一张确认卡：文案来自
 * trial-adult-ack.ts 的同一常量（trialAdultNoticeLines），并注明「确认仅对
 * 当前包生效」——包级 ack 键含 pack id，确认一个包绝不放行其它包；与旧全局
 * 键 trialAdultAgreement:v1 不互通、不迁移（键语义见 trial-adult-ack.ts）。
 * /trial 的包卡弹层（TrialScreen renderAdultAckModal）是模态形状，共用同一
 * 组常量但不复用本组件。
 */
export function TrialAdultGateCard({
  packName,
  disabled,
  onConfirm,
}: {
  /** 包名（拼进第一句警示；null 用通用句）。 */
  packName: string | null;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
      <div className="flex items-start gap-1.5 text-[13px] leading-6 text-[var(--survey-body)]">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
        <span>
          {trialAdultNoticeLines(packName).map((line, index) => (
            <span key={line} className={index === 0 ? "" : "mt-1 block"}>
              {line}
            </span>
          ))}
        </span>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onConfirm}
        className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)] disabled:opacity-50"
      >
        {TRIAL_ADULT_CONFIRM_LABEL}
      </button>
    </div>
  );
}

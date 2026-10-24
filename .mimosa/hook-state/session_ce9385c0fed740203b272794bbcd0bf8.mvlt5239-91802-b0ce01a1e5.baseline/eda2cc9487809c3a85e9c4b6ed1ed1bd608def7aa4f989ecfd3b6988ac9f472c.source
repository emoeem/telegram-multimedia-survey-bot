/**
 * 表单形状的加载骨架。
 *
 * 换掉「加载中…」一行字的原因：慢网络下那行字之后紧跟好几秒的空白，
 * 用户不知道页面是坏了还是在动。骨架的块面复刻真实表单的结构（说明行 +
 * 卡片里三组「标签 + 输入框」+ 提交按钮），加载完成前后不跳版式。
 *
 * 颜色全走 --survey-* 变量，跟表单本体同一套主题；aria-busy + aria-label
 * 交给读屏，块面本身 aria-hidden 不制造噪音。
 */
export function FormSkeleton() {
  const bar = "animate-pulse rounded-full bg-[var(--survey-primary-soft)]";
  const field = "animate-pulse h-11 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary-soft)]";
  return (
    <div className="pt-1" aria-busy="true" aria-label="正在加载表单">
      <div className={`${bar} mb-3 h-4 w-2/3`} aria-hidden="true" />
      <div className="survey-card space-y-4 p-4" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div key={index}>
            <div className={`${bar} mb-2 h-3.5 w-1/4`} />
            <div className={field} />
          </div>
        ))}
      </div>
      <div
        className="mt-4 animate-pulse h-12 rounded-[var(--survey-button-radius)] bg-[var(--survey-primary-soft)]"
        aria-hidden="true"
      />
    </div>
  );
}

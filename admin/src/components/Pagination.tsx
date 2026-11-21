import type { ReactNode } from "react";

/**
 * 后台列表页共享分页条（M10，docs/design/COMPONENT_MAPPING.md）。
 *
 * 此前 SurveysPage / UsersPage / ReportsPage 三处各自手写同构的
 * 「上一页 / 第 X/Y 页 / 下一页」标记（边界钳制与禁用逻辑重复三遍）。
 * 本组件收敛为一个入口；中间文案由调用方以 label 传入（保持各页既有
 * 「第 X / Y 页 （共 N 份）」与「第 X/Y 页」两种口径，不做视觉统一——
 * 统一文案属视觉批次，另行走基线再生）。
 */
export function TablePagination({
  page,
  totalPages,
  onChange,
  label,
  align = "end",
  className = "",
}: {
  page: number;
  totalPages: number;
  /** 上/下一页回调；越界已在组件内钳制（与既有手写逻辑一致）。 */
  onChange: (next: number) => void;
  /** 中间文案；缺省为「第 X/Y 页」。 */
  label?: ReactNode;
  align?: "center" | "end";
  className?: string;
}) {
  const max = Math.max(1, totalPages);
  return (
    <div
      className={`flex items-center gap-2 text-sm ${align === "center" ? "justify-center" : "justify-end"} ${className}`}
    >
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onChange(Math.max(1, page - 1))}>
        上一页
      </button>
      <span>{label ?? `第 ${page}/${max} 页`}</span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={page >= max}
        onClick={() => onChange(Math.min(max, page + 1))}
      >
        下一页
      </button>
    </div>
  );
}

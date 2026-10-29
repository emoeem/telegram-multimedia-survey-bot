import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Laptop, Monitor, RefreshCw, Smartphone, Tablet, X } from "lucide-react";
import type { SurveyDisplayMode } from "../../../../src/survey/display";
import { SURVEY_DISPLAY_MODE_LABELS } from "../../../../src/survey/display";

/**
 * 设备预览：iframe 加载**真实** `/s/:id?preview=1`（不是另造一套 mock）。
 *
 * 为什么是 iframe 而不是复用右栏 LivePreview：
 *  - 右栏 mock 只渲染文本/选项，场景题（HotspotScene）根本不存在，而本次
 *    「PC 沉浸 / 手机横屏」的核心正是场景版式——mock 看不到就等于没验收；
 *  - 真实页面自动跟随显示模式与所有既有逻辑，不会出现两套布局漂移。
 *
 * 代价：iframe 显示的是**已保存**版本（未保存的编辑看不到）。右栏
 * LivePreview 继续承担「含未保存修改」的近似预览，两者分工，勿合并。
 *
 * 服务端配合：`?preview=1` + 管理员会话可读草稿定义（handler 旁路，
 * 不写共享缓存）；预览页禁用最终提交，不会产生答卷。
 */
const DEVICES = [
  { id: "phone", label: "手机", width: 390, height: 844, icon: Smartphone },
  { id: "tablet", label: "平板", width: 768, height: 1024, icon: Tablet },
  { id: "desktop", label: "桌面", width: 1440, height: 900, icon: Monitor },
  { id: "wide", label: "宽屏", width: 1920, height: 1080, icon: Laptop },
] as const;

type DeviceId = (typeof DEVICES)[number]["id"];

export function DevicePreview({
  surveyId,
  title,
  display,
  onClose,
}: {
  surveyId: number;
  title: string;
  display: SurveyDisplayMode;
  onClose: () => void;
}) {
  const [deviceId, setDeviceId] = useState<DeviceId>("phone");
  // 刷新用：改写 key 重新加载 iframe（保持当前设备与已保存内容）。
  const [reloadToken, setReloadToken] = useState(0);
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const device = DEVICES.find((item) => item.id === deviceId) ?? DEVICES[0];

  // 弹层内可用空间比设备尺寸小时整体等比缩放（不裁剪、不出滚动条）。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const fit = () => {
      const availableWidth = stage.clientWidth - 16;
      const availableHeight = stage.clientHeight - 16;
      setScale(Math.min(1, availableWidth / device.width, availableHeight / device.height));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [device.width, device.height]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const modeLabel = SURVEY_DISPLAY_MODE_LABELS[display].title;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[color-mix(in_srgb,#000000_72%,transparent)] p-3">
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-2 rounded-t-2xl bg-[var(--surface)] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          设备预览 · {title}
          <span className="ml-2 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
            已保存版本 · {modeLabel}
          </span>
        </span>
        <div
          className="flex items-center gap-1 rounded-full bg-[var(--surface-muted)] p-0.5"
          role="radiogroup"
          aria-label="预览设备"
        >
          {DEVICES.map((item) => {
            const Icon = item.icon;
            const active = item.id === deviceId;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${item.label} ${item.width}×${item.height}`}
                title={`${item.label} ${item.width}×${item.height}`}
                onClick={() => setDeviceId(item.id)}
                className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  active ? "bg-[var(--surface)] shadow-sm" : "text-[var(--color-muted)]"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-quiet"
          onClick={() => setReloadToken((value) => value + 1)}
          title="重新加载已保存的最新版本"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">刷新</span>
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onClose} aria-label="关闭预览">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={stageRef}
        className="mx-auto flex w-full max-w-[1100px] flex-1 items-center justify-center overflow-hidden rounded-b-2xl bg-[var(--surface-muted)]"
      >
        <div
          style={{
            width: device.width * scale,
            height: device.height * scale,
          }}
          className="overflow-hidden rounded-xl border border-[var(--color-edge)] bg-white shadow-xl"
        >
          <iframe
            key={`${device.id}-${reloadToken}`}
            title={`${title} 设备预览（${device.label}）`}
            src={`/s/${surveyId}?preview=1`}
            width={device.width}
            height={device.height}
            style={{ transform: `scale(${scale})`, transformOrigin: "top left", border: 0 }}
          />
        </div>
      </div>
    </div>
  );
}

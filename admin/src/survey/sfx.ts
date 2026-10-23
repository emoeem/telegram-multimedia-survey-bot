/**
 * 界面音效（UI SFX）播放器 —— 视觉小说问卷的交互反馈层。
 *
 * 混音结构（audio-design 技能：按总线混音，不按单件改音量）：
 *
 *     destination ← master(-2 dB) ← { sfx(cue dB 表), music(BGM 元素由 BgmPlayer 注册) }
 *
 * 素材本身全部归一到真峰值 −3 dBTP（见 scripts/galgame/fetch_sfx.py），
 * 所以「哪条更轻」这件事只写在下面的 CUE_GAIN_DB 表里，改混音不用重做素材。
 * 音量一律用 dB 表达，转换只在边缘做（db → 线性 gain）。
 *
 * 设计约束（逐条对应验收要求）：
 * - 单一实例：整个页面只有这一个 AudioContext / master 节点，播放时按需创建
 *   一次性的 source，播完自然释放；同一 cue 45ms 内重复触发会被丢弃，
 *   连点不会叠出一串重音（也不会叠出一堆播放器）。
 * - 不阻塞阅读：`play()` 从不 await。素材没解码好就**这次不响**，而不是排队或卡住。
 * - 自动播放限制：AudioContext 只在真实用户手势里创建/resume，被浏览器拒绝时静默降级，
 *   不抛错、不写 console.error。
 * - 尊重既有开关：静音状态与 BGM 共用同一个按钮（见 setSfxEnabled / subscribeSfxEnabled），
 *   不新增控件；状态存 localStorage。
 * - 侧链闪避（ducking）：音效响起时把 BGM 压低 DUCK_DB，DUCK_MS 后恢复，
 *   音乐不会被点击声埋掉，也不需要第二个音频框架。
 */

import { identityHeaders } from "./api";

export type SfxCue = "select" | "confirm" | "cancel" | "page" | "transition";

export const SFX_CUES: readonly SfxCue[] = ["select", "confirm", "cancel", "page", "transition"];

/** 每条 cue 的总线增益（dB）。素材已统一到 −3 dBTP，所以这里就是相对混音。 */
const CUE_GAIN_DB: Record<SfxCue, number> = {
  // 选项轻点：只做「手指有反馈」，必须最轻，否则一遍问卷上百次点击会很吵。
  select: -15,
  // 提交 / 确认退出：不可逆动作，最明确的一条。
  confirm: -6,
  cancel: -8,
  page: -9,
  // 换页换场景：比 page 还轻，避免每次翻页都「啪」一声。
  transition: -12,
};

const MASTER_GAIN_DB = -2;

/** 音效播放时 BGM 的临时压低量与恢复时间（侧链闪避）。 */
const DUCK_DB = -3;
const DUCK_MS = 180;

/** 同一 cue 的最小重复间隔：连点去重，避免机关枪。 */
const MIN_REPEAT_MS = 45;

/** ±3% 音高抖动：重复的同一 cue 不会听起来完全一样。 */
const PITCH_JITTER = 0.03;

const STORAGE_KEY = "surveyAudioEnabled";

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function readEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeEnabled(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* 隐私模式等场景下写不进去也不该影响播放 */
  }
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

class SfxEngine {
  private context: AudioContext | null = null;

  private master: GainNode | null = null;

  private readonly buffers = new Map<string, AudioBuffer>();

  private readonly inflight = new Map<string, Promise<AudioBuffer | null>>();

  private urls = new Map<SfxCue, string>();

  private readonly lastPlayedAt = new Map<SfxCue, number>();

  private enabledValue = readEnabled();

  /** BgmPlayer 注册进来的音乐元素，用于侧链闪避。 */
  private musicElement: HTMLAudioElement | null = null;

  private duckTimer: ReturnType<typeof setTimeout> | null = null;

  private duckedElement: HTMLAudioElement | null = null;

  private duckedVolume = 1;

  private readonly listeners = new Set<(enabled: boolean) => void>();

  isEnabled(): boolean {
    return this.enabledValue;
  }

  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) return;
    this.enabledValue = enabled;
    writeEnabled(enabled);
    if (!enabled) this.restoreMusic();
    for (const listener of this.listeners) listener(enabled);
  }

  /** 注册（或注销）当前正在播放的 BGM 元素，只用于闪避，不控制其播放状态。 */
  registerMusicElement(element: HTMLAudioElement | null): void {
    if (this.musicElement && this.musicElement !== element) this.restoreMusic();
    this.musicElement = element;
  }

  /**
   * 声明本问卷配置的界面音效 URL。同名 cue 换源会丢弃已解码的旧缓冲；
   * 未配置的 cue 一律静默失效——老问卷没有 sfx 字段，行为完全不变。
   */
  configure(urls: Partial<Record<SfxCue, string>> | undefined): void {
    const next = new Map<SfxCue, string>();
    for (const cue of SFX_CUES) {
      const url = urls?.[cue];
      if (typeof url === "string" && url.length > 0) next.set(cue, url);
    }
    const changed = next.size !== this.urls.size || [...next].some(([cue, url]) => this.urls.get(cue) !== url);
    if (!changed) return;
    this.urls = next;
    this.buffers.clear();
    this.inflight.clear();
  }

  /**
   * 预热：首次用户手势之后调用，把素材解码进内存。
   * 只做「不阻塞」的单向努力，失败就当作没有音效，不弹提示。
   */
  preload(): void {
    if (!this.enabledValue) return;
    for (const cue of this.urls.keys()) void this.load(cue);
  }

  play(cue: SfxCue): void {
    if (!this.enabledValue) return;
    const url = this.urls.get(cue);
    if (!url) return;
    const now = Date.now();
    const last = this.lastPlayedAt.get(cue) ?? 0;
    if (now - last < MIN_REPEAT_MS) return;
    this.lastPlayedAt.set(cue, now);
    const buffer = this.buffers.get(url);
    if (!buffer) {
      // 还没解码好：这次不响，但顺手发起加载，下一次点击就有了。
      void this.load(cue);
      return;
    }
    this.emit(cue, buffer);
  }

  private async load(cue: SfxCue): Promise<AudioBuffer | null> {
    const url = this.urls.get(cue);
    if (!url) return null;
    const cached = this.buffers.get(url);
    if (cached) return cached;
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const task = (async (): Promise<AudioBuffer | null> => {
      try {
        const context = this.ensureContext();
        if (!context) return null;
        // 素材是本站 /api/survey/media/<id>，需要带身份头；跨域外链则不带，
        // 免得把参与者的 Telegram / 邮箱身份泄露给第三方主机。
        const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
        const response = await fetch(url, { headers: sameOrigin ? identityHeaders() : undefined });
        if (!response.ok) return null;
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        this.buffers.set(url, buffer);
        return buffer;
      } catch {
        // 解码失败 / 网络失败 / 被策略拦下：静默降级，不影响阅读与作答。
        return null;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, task);
    return task;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
      return this.context;
    }
    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;
    try {
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = dbToGain(MASTER_GAIN_DB);
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      if (context.state === "suspended") void context.resume().catch(() => {});
      return context;
    } catch {
      return null;
    }
  }

  private emit(cue: SfxCue, buffer: AudioBuffer): void {
    const context = this.ensureContext();
    if (!context || !this.master) return;
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1 + (Math.random() * 2 - 1) * PITCH_JITTER;
      const gain = context.createGain();
      // 每条 cue 只做 6ms 淡入，避免素材自己 4ms 淡入之外再出现爆音；
      // 淡出交给素材本身（母带时已做）。
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(dbToGain(CUE_GAIN_DB[cue]), context.currentTime + 0.006);
      source.connect(gain).connect(this.master);
      source.start();
      this.duckMusic();
    } catch {
      /* 播放失败不值得打断阅读 */
    }
  }

  private duckMusic(): void {
    const element = this.musicElement;
    if (!element || element.paused) return;
    if (this.duckTimer === null) {
      this.duckedElement = element;
      this.duckedVolume = element.volume;
    }
    element.volume = Math.max(0, Math.min(1, this.duckedVolume * dbToGain(DUCK_DB)));
    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => this.restoreMusic(), DUCK_MS);
  }

  private restoreMusic(): void {
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    if (this.duckedElement) {
      this.duckedElement.volume = this.duckedVolume;
      this.duckedElement = null;
    }
  }
}

export const sfx = new SfxEngine();

/** 便捷入口：播放一条界面音效（未配置 / 已静音 / 未解码都不会抛错）。 */
export function playSfx(cue: SfxCue): void {
  sfx.play(cue);
}

export function configureSfx(urls: Partial<Record<SfxCue, string>> | undefined): void {
  sfx.configure(urls);
}

export function preloadSfx(): void {
  sfx.preload();
}

export function sfxEnabled(): boolean {
  return sfx.isEnabled();
}

export function setSfxEnabled(enabled: boolean): void {
  sfx.setEnabled(enabled);
}

export function subscribeSfxEnabled(listener: (enabled: boolean) => void): () => void {
  return sfx.subscribe(listener);
}

/** BgmPlayer 把当前音乐元素交给音效引擎，用于侧链闪避（不改变音乐播放状态）。 */
export function registerSfxMusic(element: HTMLAudioElement | null): void {
  sfx.registerMusicElement(element);
}

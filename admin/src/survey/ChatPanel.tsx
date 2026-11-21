import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Mic, Play, Send, X } from "lucide-react";
import {
  CHAT_BASE64_MAX_CHARS,
  CHAT_TEXT_MAX_CHARS,
  CHAT_VOICE_MAX_MS,
  type GameChatChannel,
  type GameChatMessage,
} from "../../../src/game/multiplayer/engine-types";
import { filterChatByChannel } from "./game-room-logic";
import {
  compressImageToDataUrl,
  startVoiceRecording,
  voiceRecordingSupported,
  type VoiceRecording,
} from "./chat-media";

/**
 * 房间内聊天面板（批次：房间实时讨论）。
 *
 * 纯客户端展示/采集层：消息列表（文字气泡 / 语音条=时长+点击播放 / 图片
 * 缩略图点击放大）+ 输入区（文本框 / 按住说话 / 图片选择压缩）+ 频道切换。
 * 大小与频率的权威校验在服务端（GameRoomDO + chat-logic），这里只做「挡掉
 * 必被拒的」预判；被拒时服务端回 error 帧，屏层经 onNotice 弹提示，消息
 * 永远以服务端回显为准（不做乐观上屏，被拒内容不会出现在列表里）。
 *
 * 隐私纪律：语音用 Audio 解码 base64（播放时在内存里拼 data: URL，不产生
 * 持久 URL）；图片缩略图/放大直接用消息里的 data URL 渲染；二者只存在于
 * 页面内存，刷新/退出即消失。
 */

const CHANNEL_LABELS: Record<GameChatChannel, string> = {
  all: "全体",
  wolves: "狼人频道",
  dead: "观战·出局",
};

function newClientId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface ChatPanelProps {
  /** 服务端下发（已按人裁剪）的全部消息；跨频道存放，展示时按页签过滤。 */
  messages: GameChatMessage[];
  /** 我的座位令牌（信封 you，修复 1 起不再携带 participantHash）；观战为 null。 */
  myHash: string | null;
  role: "player" | "spectator";
  /** WS 连接是否可用：断连时禁输入，重连后由 chat_history 补齐。 */
  connected: boolean;
  /** 可用频道页签（屏层按身份与玩法资格给；wolves 页签仅狼人可见）。 */
  tabs: GameChatChannel[];
  onSendText: (channel: GameChatChannel, text: string, clientId: string) => void;
  onSendVoice: (
    channel: GameChatChannel,
    voice: { audioBase64: string; durationMs: number; mimeType: string },
    clientId: string,
  ) => void;
  onSendImage: (channel: GameChatChannel, dataUrl: string, clientId: string) => void;
  /** 非致命提示（限流/超限/播放失败等）由屏层 toast。 */
  onNotice: (message: string) => void;
}

export function ChatPanel({
  messages,
  myHash,
  role,
  connected,
  tabs,
  onSendText,
  onSendVoice,
  onSendImage,
  onNotice,
}: ChatPanelProps) {
  const [channel, setChannel] = useState<GameChatChannel>(tabs[0] ?? "all");
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  /** 正在播放的语音（seq）与放大查看的图片（dataUrl），二者都是页面内存态。 */
  const [playingSeq, setPlayingSeq] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  /** 页签切到当前身份不可用的频道（重连/身份变化后的防御）：回退到第一个可用页签。 */
  useEffect(() => {
    if (!tabs.includes(channel)) setChannel(tabs[0] ?? "all");
  }, [channel, tabs]);

  /** 新消息/切页签后滚到底部（聊天列表的常规交互）。 */
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, channel]);

  useEffect(
    () => () => {
      // 卸载即收尾：录音器/音频元素/计时器都不留尾巴。
      recordingRef.current?.stop();
      recordingRef.current = null;
      if (tickRef.current !== null) clearInterval(tickRef.current);
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const visible = useMemo(() => filterChatByChannel(messages, channel), [channel, messages]);

  const sendText = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    onSendText(channel, trimmed, newClientId());
    setText("");
  }, [channel, connected, onSendText, text]);

  // ------------------------------------------------------------------
  // 按住说话：pointerdown 开始 / pointerup 松手即发；60s 由采集器自动停
  // ------------------------------------------------------------------

  const stopTalk = useCallback(() => {
    const pending = recordingRef.current;
    if (!pending) return;
    recordingRef.current = null;
    setRecording(false);
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    pending.stop();
    void pending.result
      .then((voice) => {
        if (!voice.audioBase64) {
          onNotice("录音失败，请再试一次");
          return;
        }
        // 发送前本地拦截：采集层已按 24kbps 录制（60s ≈ 240K 字符 < 上限），
        // 个别浏览器忽略 audioBitsPerSecond 时兜底，不再把必被拒的载荷发出去。
        if (voice.audioBase64.length > CHAT_BASE64_MAX_CHARS) {
          onNotice("语音超过 300KB，请缩短时长后重录");
          return;
        }
        onSendVoice(channel, voice, newClientId());
      })
      .catch(() => onNotice("录音失败，请再试一次"));
  }, [channel, onNotice, onSendVoice]);

  const startTalk = useCallback(() => {
    // 录音态以 ref 为准（pointerdown 可能在 setState 生效前连击）。
    if (recordingRef.current !== null || !connected) return;
    if (!voiceRecordingSupported()) {
      onNotice("当前浏览器不支持语音，请用文字或图片");
      return;
    }
    try {
      const pending = startVoiceRecording();
      recordingRef.current = pending;
      setRecording(true);
      setRecordingMs(0);
      tickRef.current = setInterval(() => setRecordingMs((ms) => Math.min(CHAT_VOICE_MAX_MS, ms + 200)), 200);
    } catch {
      onNotice("无法访问麦克风，请检查浏览器权限");
    }
  }, [connected, onNotice]);

  // ------------------------------------------------------------------
  // 图片：选择即压缩（≤1280px / 质量 0.7 / ≤300KB data URL），压完即发
  // ------------------------------------------------------------------

  const handleImageFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !connected) return;
      if (!file.type.startsWith("image/")) {
        onNotice("只能发送图片");
        return;
      }
      try {
        const dataUrl = await compressImageToDataUrl(file);
        onSendImage(channel, dataUrl, newClientId());
      } catch {
        onNotice("图片压缩后仍超过 300KB，换一张小一点的吧");
      }
    },
    [channel, connected, onNotice, onSendImage],
  );

  const playVoice = useCallback(
    (message: GameChatMessage) => {
      if (!message.voice) return;
      audioRef.current?.pause();
      // 播放时在内存里拼 data: URL 交给 Audio 解码——不产生持久 URL、不落盘。
      const audio = new Audio(`data:${message.voice.mimeType};base64,${message.voice.audioBase64}`);
      audioRef.current = audio;
      setPlayingSeq(message.seq);
      audio.onended = () => setPlayingSeq(null);
      const fail = () => {
        setPlayingSeq(null);
        onNotice("这段语音播放失败");
      };
      audio.onerror = fail;
      void audio.play().catch(fail);
    },
    [onNotice],
  );

  const renderMessage = (message: GameChatMessage) => {
    // 「我发的」按座位令牌对位（修复 1：fromHash → fromSeat）；观战者消息
    // fromSeat 为空串，恒不命中（回显仍按 clientId 在发送侧去重）。
    const mine = myHash !== null && message.fromSeat !== "" && message.fromSeat === myHash;
    const rowTone = mine ? "items-end" : "items-start";
    const nameTone = mine ? "text-right" : "text-left";
    return (
      <div key={message.seq} className={`flex flex-col gap-0.5 ${rowTone}`}>
        <p className={`px-1 text-[10px] font-medium text-[var(--survey-muted)] ${nameTone}`}>
          {message.from}
          {mine ? "（我）" : ""}
        </p>
        {message.kind === "text" ? (
          <div
            className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed break-words ${
              mine
                ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                : "bg-[color-mix(in_srgb,var(--survey-card-border)_60%,var(--survey-card-bg))] text-[var(--survey-heading)]"
            }`}
          >
            {message.text}
          </div>
        ) : message.kind === "voice" && message.voice ? (
          <button
            type="button"
            onClick={() => playVoice(message)}
            aria-label={`播放 ${message.from} 的语音（${Math.max(1, Math.round(message.voice.durationMs / 1000))} 秒）`}
            className={`flex max-w-[80%] items-center gap-2 rounded-2xl px-3 py-2 text-[12px] font-semibold ${
              mine
                ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                : "bg-[color-mix(in_srgb,var(--survey-card-border)_60%,var(--survey-card-bg))] text-[var(--survey-heading)]"
            }`}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {playingSeq === message.seq ? "播放中…" : "语音"}
            <span className="tabular-nums">{Math.max(1, Math.round(message.voice.durationMs / 1000))}″</span>
          </button>
        ) : message.kind === "image" && message.image ? (
          <button
            type="button"
            onClick={() => setLightbox(message.image!.dataUrl)}
            aria-label="查看图片"
            className="max-w-[80%] overflow-hidden rounded-2xl border border-[var(--survey-card-border)]"
          >
            <img src={message.image.dataUrl} alt="房间图片消息" className="max-h-32 w-auto object-cover" />
          </button>
        ) : (
          <div className="rounded-2xl bg-[color-mix(in_srgb,var(--survey-card-border)_60%,var(--survey-card-bg))] px-3 py-1.5 text-[12px] text-[var(--survey-muted)]">
            [不支持的消息类型]
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="survey-card p-4" aria-label="房间聊天">
      <div className="flex items-center gap-2" role="tablist" aria-label="聊天频道">
        {tabs.map((tab) => {
          const active = tab === channel;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setChannel(tab)}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold transition ${
                active
                  ? "bg-[var(--survey-primary)] text-[var(--survey-primary-content)]"
                  : "bg-[var(--survey-primary-soft)] text-[var(--survey-primary)]"
              }`}
            >
              {CHANNEL_LABELS[tab]}
            </button>
          );
        })}
        <span className="min-w-0 flex-1 truncate text-right text-[10px] text-[var(--survey-muted)]">
          {role === "spectator" ? "观战可发言 · 对局结束即焚" : "对局结束即焚"}
        </span>
      </div>

      <div ref={listRef} className="mt-3 flex max-h-64 min-h-24 flex-col gap-2 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="my-auto text-center text-[12px] text-[var(--survey-muted)]">
            {CHANNEL_LABELS[channel]}频道还没有消息，说点什么吧
          </p>
        ) : (
          visible.map(renderMessage)
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          className="input min-w-0 flex-1"
          value={text}
          maxLength={CHAT_TEXT_MAX_CHARS}
          placeholder={connected ? `在${CHANNEL_LABELS[channel]}频道说点什么…` : "连接中断，暂不能发言"}
          aria-label="聊天输入框"
          disabled={!connected}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) sendText();
          }}
        />
        <button
          type="button"
          className="survey-icon-btn shrink-0"
          aria-label="发送消息"
          title="发送"
          disabled={!connected || !text.trim()}
          onClick={sendText}
        >
          <Send className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={`survey-icon-btn shrink-0 ${recording ? "animate-pulse" : ""}`}
          aria-label={recording ? "松开发送语音" : "按住说话"}
          aria-pressed={recording}
          title={recording ? `松开发送（${Math.round(recordingMs / 1000)}s）` : "按住说话"}
          disabled={!connected}
          onPointerDown={() => void startTalk()}
          onPointerUp={stopTalk}
          onPointerLeave={stopTalk}
          onPointerCancel={stopTalk}
          onContextMenu={(event) => event.preventDefault()}
        >
          <Mic className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="survey-icon-btn shrink-0"
          aria-label="发送图片"
          title="发送图片（自动压缩）"
          disabled={!connected}
          onClick={() => imageInputRef.current?.click()}
        >
          <ImagePlus className="h-4 w-4" />
        </button>
      </div>
      {/* 图片选择即压缩：canvas ≤1280px / JPEG 质量 0.7 / ≤300KB data URL。 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          void handleImageFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {lightbox ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-label="查看图片"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="房间图片消息放大" className="max-h-full max-w-full rounded-xl" />
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white"
            aria-label="关闭图片"
            onClick={() => setLightbox(null)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : null}
    </section>
  );
}

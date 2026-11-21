/**
 * 房间内聊天的媒体采集/压缩（批次：房间实时讨论）。
 *
 * 纯浏览器 API（MediaRecorder/canvas/FileReader），没有可 node 单测的纯逻辑，
 * 所以刻意做薄：限额常量来自协议层（engine-types），发送前的最终校验由
 * 服务端 chat-logic 收口（超限返回明确错误码），这里做「挡掉必被拒的」
 * 客户端预判——图片三轮降质缩边（compressImageToDataUrl）、语音显式 24kbps
 * 码率（VOICE_AUDIO_BITS_PER_SECOND，Chromium 默认 128kbps 只能录 ~14s 就撞
 * 300KB base64 上限），发送前的大小拦截在 ChatPanel.stopTalk。采集的语音/
 * 图片只在内存里转 base64，不产生任何持久 URL、不写任何存储。
 */
import { CHAT_BASE64_MAX_CHARS, CHAT_VOICE_MAX_MS } from "../../../src/game/multiplayer/engine-types";

/** 图片最长边（客户端 canvas 压缩上限，协议要求 ≤1280px）。 */
export const IMAGE_MAX_EDGE = 1280;
/** 首轮 JPEG 压缩质量（协议要求 0.7；仍超 300KB 时逐轮降质缩边）。 */
export const IMAGE_QUALITY = 0.7;
/**
 * 语音显式码率（bits/s）。必须显式设：Chromium 系未指定时默认 128kbps
 * （media_recorder.cc kDefaultAudioBitsPerSecond = 128e3），300KB base64 上限
 * ≈ 230KB 二进制只容得下 ~14.4s，60s 录满必被服务端拒。24kbps 下 60s =
 * 180KB 二进制 ≈ 240K base64 字符（上限的 78%），全程可录；opus 24kbps 对
 * 人声足够清晰。
 */
export const VOICE_AUDIO_BITS_PER_SECOND = 24_000;

/** Blob → 纯 base64（剥掉 data: 前缀；语音发送用）。 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const index = result.indexOf(",");
      resolve(index >= 0 ? result.slice(index + 1) : "");
    };
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * File/Blob → canvas 压缩（≤1280px、JPEG 质量 0.7）的 data URL。首轮按协议
 * 参数压；仍超 300KB 上限就缩边再压，三轮后仍超限抛错（调用方提示换图）。
 * data URL 只在内存里传给 WS 发送，绝不持久化。
 */
export async function compressImageToDataUrl(source: Blob): Promise<string> {
  const bitmap = await createImageBitmap(source);
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    let scale = edge > IMAGE_MAX_EDGE ? IMAGE_MAX_EDGE / edge : 1;
    for (const quality of [IMAGE_QUALITY, 0.5, 0.35]) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= CHAT_BASE64_MAX_CHARS) return dataUrl;
      scale *= 0.7;
    }
    throw new Error("image-too-large");
  } finally {
    bitmap.close();
  }
}

export interface VoiceCapture {
  audioBase64: string;
  durationMs: number;
  mimeType: string;
}

export interface VoiceRecording {
  /** 停止录音（用户松手或 60s 自动停都会触发）。 */
  stop: () => void;
  /** 停止后 resolve 的采集结果（base64/时长/mime）。 */
  result: Promise<VoiceCapture>;
}

/** 当前浏览器是否支持按住说话（MediaRecorder + 麦克风）。 */
export function voiceRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * 按住说话的录音器：MediaRecorder（webm/opus 优先），显式 24kbps 码率保证
 * 录满 60s 也压在 300KB base64 上限内，最长 60s 自动停。音轨在 stop 时释放
 * （不给页面留常驻麦克风占用）。
 */
export function startVoiceRecording(): VoiceRecording {
  if (!voiceRecordingSupported()) throw new Error("voice-unsupported");
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let stopped = false;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  const chunks: Blob[] = [];
  const startedAt = Date.now();

  const clearAutoStop = () => {
    if (autoStopTimer !== null) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
  };

  const result = new Promise<VoiceCapture>((resolve, reject) => {
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((mediaStream) => {
        stream = mediaStream;
        // webm/opus 优先（协议要求），容器不支持时退回浏览器默认音频容器。
        // audioBitsPerSecond 两个分支都显式给：不依赖浏览器默认码率（Chromium
        // 默认 128kbps，录满 60s ≈ 1.28MB base64，必撞 300KB 协议上限）。
        const preferred = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        recorder = preferred
          ? new MediaRecorder(mediaStream, { mimeType: preferred, audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND })
          : new MediaRecorder(mediaStream, { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND });
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = async () => {
          clearAutoStop();
          stream?.getTracks().forEach((track) => track.stop());
          try {
            const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
            const audioBase64 = await blobToBase64(blob);
            resolve({
              audioBase64,
              durationMs: Math.min(CHAT_VOICE_MAX_MS, Math.max(1, Date.now() - startedAt)),
              mimeType: recorder?.mimeType || "audio/webm",
            });
          } catch {
            reject(new Error("encode-failed"));
          }
        };
        recorder.onerror = () => {
          clearAutoStop();
          stream?.getTracks().forEach((track) => track.stop());
          reject(new Error("record-failed"));
        };
        recorder.start();
        // 协议上限：最长 60s，到点自动停（用户先松手则由 stop() 清掉本计时器）。
        autoStopTimer = setTimeout(() => {
          autoStopTimer = null;
          if (recorder?.state === "recording") recorder.stop();
        }, CHAT_VOICE_MAX_MS);
      })
      .catch(() => reject(new Error("permission-denied")));
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearAutoStop();
      // stop() 触发 onstop → result resolve；stream 由 onstop 统一释放。
      if (recorder?.state === "recording") recorder.stop();
      else stream?.getTracks().forEach((track) => track.stop());
    },
    result,
  };
}

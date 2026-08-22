import { useEffect, useState } from "react";
import { apiBlob, type ResponseAnswerView } from "../api";

type Media = ResponseAnswerView["media"][number];

export function ResponseMediaPreview({
  surveyId,
  responseId,
  media,
}: {
  surveyId: number;
  responseId: number;
  media: Media;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    apiBlob(`/api/admin/surveys/${surveyId}/responses/${responseId}/media/${media.mediaAssetId}`)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((requestError: Error) => {
        if (active) setError(requestError.message || "媒体加载失败");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media.mediaAssetId, responseId, surveyId]);

  if (error) return <span className="text-xs text-red-600">{error}</span>;
  if (!url) return <span className="text-xs text-gray-400">媒体加载中…</span>;

  const label = media.fileName || `${media.mediaType} #${media.mediaAssetId}`;
  if (media.mediaType === "photo" || media.mediaType === "gif" || media.mediaType === "sticker") {
    return <img className="max-h-80 max-w-full rounded-lg border border-gray-200 object-contain" src={url} alt={label} />;
  }
  if (media.mediaType === "video" || media.mediaType === "animation") {
    return <video className="max-h-80 max-w-full rounded-lg border border-gray-200" src={url} controls preload="metadata" />;
  }
  if (media.mediaType === "audio" || media.mediaType === "voice") {
    return <audio className="max-w-full" src={url} controls preload="metadata" />;
  }
  return <a className="btn btn-sm inline-block" href={url} download={media.fileName || undefined}>下载 {label}</a>;
}

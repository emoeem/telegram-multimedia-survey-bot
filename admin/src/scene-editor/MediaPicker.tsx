import { useRef } from "react";
import { Upload } from "lucide-react";
import type { EditorMediaRef } from "../api";
import { Modal } from "../components/ui";
import { adminMediaUrl, imageMediaFilter, mediaIdFromUrl } from "./model";

interface MediaPickerProps {
  title: string;
  media: EditorMediaRef[];
  currentUrl: string | null;
  uploading: boolean;
  readOnly: boolean;
  onClose: () => void;
  onSelect: (mediaAssetId: number) => void;
  onUpload: (file: File) => void;
}

/**
 * 题目媒体选择器：只列已经挂在这道题上的图片，外加一个上传入口。
 * 上传走既有 POST /questions/:qid/media，返回的素材会立即挂到 question_media。
 */
export function MediaPicker({
  title,
  media,
  currentUrl,
  uploading,
  readOnly,
  onClose,
  onSelect,
  onUpload,
}: MediaPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const images = media.filter(imageMediaFilter);
  const currentId = mediaIdFromUrl(currentUrl);

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <div className="scene-editor-media-picker">
        <div className="scene-editor-media-head">
          <p>从已经挂到这道题的图片中选择，或上传新图（JPG / PNG / WebP，单张 ≤20MB）。</p>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn"
              disabled={readOnly || uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              {uploading ? "上传中…" : "上传新图片"}
            </button>
          </div>
        </div>

        {currentUrl && currentId === null ? (
          <p className="scene-editor-hint">当前使用的是外部图片链接；选择下面的图片会替换它。</p>
        ) : null}

        {images.length === 0 ? (
          <p className="scene-editor-hint">这道题还没有图片，先上传一张。</p>
        ) : (
          <div className="scene-editor-media-grid">
            {images.map((item) => (
              <button
                key={item.mediaAssetId}
                type="button"
                className={`scene-editor-media-item${currentId === item.mediaAssetId ? " is-current" : ""}`}
                disabled={readOnly || uploading}
                onClick={() => onSelect(item.mediaAssetId)}
              >
                <img src={adminMediaUrl(item.mediaAssetId)} alt={item.fileName ?? "题目图片"} loading="lazy" />
                <span>{item.fileName ?? `#${item.mediaAssetId}`}</span>
                {currentId === item.mediaAssetId ? <em>当前</em> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

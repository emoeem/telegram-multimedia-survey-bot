import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, ImagePlus, Pencil, Plus, Trash2, Upload } from "lucide-react";
import {
  createShowcaseItem,
  createShowcasePerson,
  deleteShowcaseItem,
  deleteShowcasePerson,
  restoreShowcaseItem,
  restoreShowcasePerson,
  fetchAdminShowcase,
  reorderShowcasePersons,
  updateShowcaseItem,
  updateShowcasePerson,
  uploadShowcaseMedia,
  type ShowcaseAdminData,
  type ShowcaseAdminItem,
  type ShowcaseAdminPerson,
  type ShowcaseItemKind,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { DeleteWithUndo } from "../components/DeleteWithUndo";
import { EmptyPanel, ErrorPanel, Modal, PageHeader, SkeletonPanel } from "../components/ui";

/**
 * Showcase (展示区) management.
 *
 * Built from the shared primitives (PageHeader / EmptyPanel / Modal / .card /
 * .btn / .input) rather than one-off markup: an operator page that drifts from
 * the design system is how the panel ended up with four different modals.
 */

const KIND_OPTIONS: Array<{ id: ShowcaseItemKind; label: string }> = [
  { id: "image", label: "图片" },
  { id: "article", label: "文章" },
  { id: "audio", label: "音频" },
  { id: "video", label: "视频" },
  { id: "project", label: "项目" },
  { id: "github", label: "GitHub" },
  { id: "website", label: "网站" },
  { id: "social", label: "社交媒体" },
  { id: "survey", label: "问卷" },
  { id: "other", label: "其他" },
];

const LINK_TYPE_OPTIONS = [
  { id: "github", label: "GitHub" },
  { id: "website", label: "网站" },
  { id: "social", label: "社交媒体" },
  { id: "telegram", label: "Telegram" },
  { id: "email", label: "邮箱" },
  { id: "other", label: "其他" },
];

interface LinkDraft {
  type: string;
  label: string;
  url: string;
}

interface PersonDraft {
  name: string;
  subtitle: string;
  description: string;
  accentColor: string;
  backgroundFrom: string;
  backgroundTo: string;
  illustrationMediaId: number | null;
  illustrationPreview: string | null;
  illustrationUrl: string;
  backgroundMediaId: number | null;
  backgroundPreview: string | null;
  backgroundUrl: string;
  avatarMediaId: number | null;
  avatarPreview: string | null;
  tags: string;
  links: LinkDraft[];
  surveyId: string;
  published: boolean;
}

function draftFromPerson(person: ShowcaseAdminPerson | null): PersonDraft {
  return {
    name: person?.name ?? "",
    subtitle: person?.subtitle ?? "",
    description: person?.description ?? "",
    accentColor: person?.accentColor ?? "",
    backgroundFrom: person?.backgroundFrom ?? "",
    backgroundTo: person?.backgroundTo ?? "",
    illustrationMediaId: person?.illustrationMediaId ?? null,
    illustrationPreview: person?.illustrationUrl ?? null,
    illustrationUrl: person?.illustrationMediaId ? "" : (person?.illustrationUrl ?? ""),
    backgroundMediaId: person?.backgroundMediaId ?? null,
    backgroundPreview: person?.background?.imageUrl ?? null,
    backgroundUrl: person?.backgroundMediaId ? "" : (person?.backgroundUrl ?? ""),
    avatarMediaId: person?.avatarMediaId ?? null,
    avatarPreview: person?.avatarUrl ?? null,
    tags: person?.tags.join(", ") ?? "",
    links: person?.links.map((link) => ({ type: link.type, label: link.label, url: link.url })) ?? [],
    surveyId: person?.surveyId ? String(person.surveyId) : "",
    published: person?.published ?? false,
  };
}

function ImageField({
  label,
  hint,
  mediaId,
  preview,
  urlValue,
  busy,
  onUpload,
  onClear,
  onUrlChange,
}: {
  label: string;
  hint: string;
  mediaId: number | null;
  preview: string | null;
  urlValue: string;
  busy: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
  onUrlChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-ink)]">{label}</span>
        <span className="text-[11px] text-[var(--color-muted)]">{hint}</span>
      </div>
      <div className="flex items-start gap-3">
        <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--surface-muted)]">
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-5 w-5 text-[var(--color-muted-soft)]" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? "上传中…" : mediaId ? "替换图片" : "上传图片"}
            </button>
            {mediaId ? (
              <button type="button" className="btn btn-sm" onClick={onClear} disabled={busy}>
                移除
              </button>
            ) : null}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <input
            className="input"
            placeholder="或直接填写图片地址 https://…"
            value={urlValue}
            disabled={mediaId !== null}
            onChange={(event) => onUrlChange(event.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function ItemRow({
  item,
  onRefresh,
  onError,
}: {
  item: ShowcaseAdminItem;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState({
    title: item.title,
    kind: item.kind,
    url: item.url ?? "",
    description: item.description ?? "",
    mediaAssetId: item.mediaAssetId ?? null,
    mediaUrl: item.mediaUrl ?? null,
  });
  const [busy, setBusy] = useState(false);

  // 作品本体：图片 / 音频 / 视频都走同一个上传接口（管理端媒体库，20MB 上限）。
  const uploadMedia = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await uploadShowcaseMedia(file);
      setDraft((current) => ({ ...current, mediaAssetId: result.mediaAssetId, mediaUrl: result.url }));
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await updateShowcaseItem(item.id, {
        title: draft.title.trim(),
        kind: draft.kind,
        url: draft.url.trim() || null,
        description: draft.description.trim() || null,
        mediaAssetId: draft.mediaAssetId,
      });
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleFeatured = async () => {
    setBusy(true);
    try {
      await updateShowcaseItem(item.id, { featured: !item.featured });
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteShowcaseItem(item.id);
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-edge)] bg-[var(--surface-2)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-0 flex-1"
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder="作品标题"
        />
        <select
          className="select w-auto"
          value={draft.kind}
          onChange={(event) => setDraft({ ...draft, kind: event.target.value as ShowcaseItemKind })}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <input
        className="input"
        value={draft.url}
        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
        placeholder="作品链接 https://…（外链作品；站内查看的内容用下面的作品文件）"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn btn-sm cursor-pointer">
          <Upload className="h-4 w-4" />
          {draft.mediaAssetId ? "替换作品文件" : "上传作品文件（图片 / 音频 / 视频）"}
          <input
            type="file"
            accept="image/*,audio/*,video/*"
            className="hidden"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void uploadMedia(file);
            }}
          />
        </label>
        {draft.mediaAssetId ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => setDraft((current) => ({ ...current, mediaAssetId: null, mediaUrl: null }))}
          >
            移除作品文件
          </button>
        ) : null}
      </div>
      {draft.mediaUrl ? (
        <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--surface-1)] p-2">
          {draft.kind === "audio" ? (
            <audio src={draft.mediaUrl} controls preload="metadata" className="w-full" />
          ) : draft.kind === "video" ? (
            <video src={draft.mediaUrl} controls preload="metadata" className="w-full rounded-md" />
          ) : (
            <img src={draft.mediaUrl} alt="作品文件预览" className="max-h-48 rounded-md object-contain" />
          )}
        </div>
      ) : null}
      <textarea
        className="input min-h-[64px] resize-y"
        value={draft.description}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        placeholder="简介；文章 / 小说可以直接把正文写在这里（最多 20000 字），前台点作品卡片即可阅读全文"
      />
      <p className="muted text-[11px] leading-4">
        简介会显示在作品卡片上（最多两行预览）；文字作品点开后是这一整段正文。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="chip cursor-pointer">
          <input type="checkbox" checked={item.featured} disabled={busy} onChange={() => void toggleFeatured()} />
          精选
        </label>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>
          保存作品
        </button>
        <DeleteWithUndo
          confirmMessage="删除此作品？作品会保留 30 天，可从回收站恢复。"
          onDelete={remove}
          onUndo={async () => {
            await restoreShowcaseItem(item.id);
            onRefresh();
          }}
          className="btn btn-sm btn-danger"
          disabled={busy}
        >
          <Trash2 className="h-4 w-4" />
          删除
        </DeleteWithUndo>
      </div>
    </div>
  );
}

export function ShowcasePage() {
  const { data, error, retry } = useApi<ShowcaseAdminData>("/api/admin/showcase");
  const { toast } = useDialogs();
  const [editing, setEditing] = useState<ShowcaseAdminPerson | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const showError = (message: string) => toast({ message, variant: "error" });

  const persons = data?.persons ?? [];

  const move = async (person: ShowcaseAdminPerson, direction: -1 | 1) => {
    const ids = persons.map((entry) => entry.id);
    const position = ids.indexOf(person.id);
    const target = position + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[position], ids[target]] = [ids[target]!, ids[position]!];
    setBusyId(person.id);
    try {
      await reorderShowcasePersons(ids);
      retry();
    } catch (err) {
      showError(err instanceof Error ? err.message : "排序失败");
    } finally {
      setBusyId(null);
    }
  };

  const togglePublished = async (person: ShowcaseAdminPerson) => {
    setBusyId(person.id);
    try {
      await updateShowcasePerson(person.id, { published: !person.published });
      retry();
    } catch (err) {
      showError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (person: ShowcaseAdminPerson) => {
    setBusyId(person.id);
    try {
      await deleteShowcasePerson(person.id);
      retry();
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="展示区"
        actions={
          <>
            <a className="btn" href="/showcase" target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              打开展示区
            </a>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              新建人物
            </button>
          </>
        }
      />

      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={6} />
      ) : persons.length === 0 ? (
        <EmptyPanel
          text="展示区还没有人物。创建第一位创作者后，参与者就能在 /showcase 左右滑动浏览。"
          actionLabel="创建第一位人物"
          onAction={() => setCreating(true)}
        />
      ) : (
        <>
          <p className="muted text-sm">
            共 {data.total} 位 · 已公开 {data.publishedTotal} 位 · 顺序即前台展示顺序
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {persons.map((person, position) => (
              <article key={person.id} className="card flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-[var(--surface-muted)]">
                    {person.illustrationUrl || person.avatarUrl ? (
                      <img
                        src={person.avatarUrl ?? person.illustrationUrl ?? ""}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-bold text-[var(--color-muted)]">{person.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-base font-semibold">{person.name}</h3>
                    <p className="truncate text-xs text-[var(--color-muted)]">{person.subtitle || "未填写副标题"}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <span className={`badge ${person.published ? "badge-green" : "badge-gray"} badge-dot`}>
                        {person.published ? "已公开" : "未公开"}
                      </span>
                      <span className="badge badge-blue">作品 {person.items.length}</span>
                      {person.surveyId ? <span className="badge badge-indigo">问卷 #{person.surveyId}</span> : null}
                      {person.responseId ? (
                        <span className="badge badge-amber" title="由参与者的资料卡生成，公开前建议先核对">
                          来自画廊 #{person.responseId}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                {person.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {person.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="toolbar mt-auto">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(person)}>
                    <Pencil className="h-4 w-4" />
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === person.id || position === 0}
                    onClick={() => void move(person, -1)}
                    aria-label="上移"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === person.id || position === persons.length - 1}
                    onClick={() => void move(person, 1)}
                    aria-label="下移"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === person.id}
                    onClick={() => void togglePublished(person)}
                  >
                    {person.published ? "下架" : "公开"}
                  </button>
                  <DeleteWithUndo
                    confirmMessage={`删除展示人物「${person.name}」？其作品会一起进入回收站，保留 30 天。`}
                    onDelete={() => remove(person)}
                    onUndo={async () => {
                      await restoreShowcasePerson(person.id);
                      retry();
                    }}
                    className="btn btn-sm btn-danger"
                    disabled={busyId === person.id}
                  >
                    <Trash2 className="h-4 w-4" />
                  </DeleteWithUndo>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <PersonDialog
        open={creating || editing !== null}
        person={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved) => {
          retry();
          setCreating(false);
          setEditing(saved);
        }}
        onRefresh={retry}
        onError={showError}
        onDone={(message) => toast({ message, variant: "success" })}
      />
    </div>
  );
}

function PersonDialog({
  open,
  person,
  onClose,
  onSaved,
  onRefresh,
  onError,
  onDone,
}: {
  open: boolean;
  person: ShowcaseAdminPerson | null;
  onClose: () => void;
  onSaved: (person: ShowcaseAdminPerson | null) => void;
  onRefresh: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [draft, setDraft] = useState<PersonDraft>(() => draftFromPerson(person));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<"illustration" | "background" | "avatar" | null>(null);
  const [personKey, setPersonKey] = useState<string>("");

  // Re-seed the form whenever the dialog is (re)opened for a different person.
  const key = `${open ? "open" : "closed"}:${person?.id ?? "new"}:${person?.published ?? false}:${
    person?.items.length ?? 0
  }`;
  if (key !== personKey) {
    setPersonKey(key);
    setDraft(draftFromPerson(person));
  }

  const buildPayload = () => ({
    name: draft.name.trim(),
    subtitle: draft.subtitle.trim() || null,
    description: draft.description.trim() || null,
    accentColor: draft.accentColor || null,
    backgroundFrom: draft.backgroundFrom || null,
    backgroundTo: draft.backgroundTo || null,
    illustrationMediaId: draft.illustrationMediaId,
    illustrationUrl: draft.illustrationMediaId ? null : draft.illustrationUrl.trim() || null,
    backgroundMediaId: draft.backgroundMediaId,
    backgroundUrl: draft.backgroundMediaId ? null : draft.backgroundUrl.trim() || null,
    avatarMediaId: draft.avatarMediaId,
    tags: draft.tags
      .split(/[,，、\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    links: draft.links
      .filter((link) => link.url.trim())
      .map((link) => ({ type: link.type, label: link.label.trim() || link.url.trim(), url: link.url.trim() })),
    surveyId: draft.surveyId.trim() ? Number(draft.surveyId) : null,
    published: draft.published,
  });

  const save = async () => {
    if (!draft.name.trim()) {
      onError("请填写昵称");
      return;
    }
    setSaving(true);
    try {
      const result = person
        ? await updateShowcasePerson(person.id, buildPayload())
        : await createShowcasePerson(buildPayload());
      onDone(person ? "已保存" : "已创建");
      onSaved(result.person);
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File, field: "illustration" | "background" | "avatar") => {
    setUploading(field);
    try {
      const result = await uploadShowcaseMedia(file);
      setDraft((current) => {
        if (field === "illustration") {
          return { ...current, illustrationMediaId: result.mediaAssetId, illustrationPreview: result.url };
        }
        if (field === "background") {
          return { ...current, backgroundMediaId: result.mediaAssetId, backgroundPreview: result.url };
        }
        return { ...current, avatarMediaId: result.mediaAssetId, avatarPreview: result.url };
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={person ? `编辑「${person.name}」` : "新建展示人物"}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : person ? "保存修改" : "创建人物"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-bold">基本信息</h3>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-muted)]">昵称（必填，≤40 字）</span>
            <input
              className="input"
              value={draft.name}
              maxLength={40}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-muted)]">副标题（一句话身份）</span>
            <input
              className="input"
              value={draft.subtitle}
              maxLength={60}
              onChange={(event) => setDraft({ ...draft, subtitle: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-muted)]">个人简介</span>
            <textarea
              className="input min-h-[90px] resize-y"
              value={draft.description}
              maxLength={800}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-muted)]">标签（用逗号分隔，最多 8 个）</span>
            <input
              className="input"
              value={draft.tags}
              onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
              placeholder="插画, 角色设计, 世界观"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--color-muted)]">
              关联问卷编号（可留空；填写后前台显示「查看我的问卷」）
            </span>
            <input
              className="input"
              inputMode="numeric"
              value={draft.surveyId}
              onChange={(event) => setDraft({ ...draft, surveyId: event.target.value.replace(/[^0-9]/g, "") })}
              placeholder="例如 12"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.published}
              onChange={(event) => setDraft({ ...draft, published: event.target.checked })}
            />
            <span className="text-sm">立即公开到展示区</span>
          </label>
        </section>

        <section className="flex flex-col gap-4">
          <h3 className="text-sm font-bold">视觉素材</h3>
          <ImageField
            label="立绘"
            hint="建议 PNG 透明背景，长边 1200px 以上"
            mediaId={draft.illustrationMediaId}
            preview={draft.illustrationPreview}
            urlValue={draft.illustrationUrl}
            busy={uploading === "illustration"}
            onUpload={(file) => void upload(file, "illustration")}
            onClear={() => setDraft({ ...draft, illustrationMediaId: null, illustrationPreview: null })}
            onUrlChange={(value) => setDraft({ ...draft, illustrationUrl: value, illustrationPreview: value || null })}
          />
          <ImageField
            label="背景图"
            hint="全屏铺底，建议 1600px 以上"
            mediaId={draft.backgroundMediaId}
            preview={draft.backgroundPreview}
            urlValue={draft.backgroundUrl}
            busy={uploading === "background"}
            onUpload={(file) => void upload(file, "background")}
            onClear={() => setDraft({ ...draft, backgroundMediaId: null, backgroundPreview: null })}
            onUrlChange={(value) => setDraft({ ...draft, backgroundUrl: value, backgroundPreview: value || null })}
          />
          <ImageField
            label="头像"
            hint="资料面板里的小图（可选）"
            mediaId={draft.avatarMediaId}
            preview={draft.avatarPreview}
            urlValue=""
            busy={uploading === "avatar"}
            onUpload={(file) => void upload(file, "avatar")}
            onClear={() => setDraft({ ...draft, avatarMediaId: null, avatarPreview: null })}
            onUrlChange={() => undefined}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(
              [
                ["accentColor", "主题色", "#7c8cff"],
                ["backgroundFrom", "背景起始色", "#182042"],
                ["backgroundTo", "背景结束色", "#05070d"],
              ] as const
            ).map(([field, label, fallback]) => (
              <div key={field} className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 shrink-0 rounded-lg border border-[var(--color-edge)] bg-transparent"
                  value={draft[field] || fallback}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
                <span className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">{label}</span>
                {draft[field] ? (
                  <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, [field]: "" })}>
                    清除
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">社交链接</h3>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDraft({ ...draft, links: [...draft.links, { type: "website", label: "", url: "" }] })}
            >
              <Plus className="h-4 w-4" />
              添加链接
            </button>
          </div>
          {draft.links.length === 0 ? (
            <p className="muted text-xs">还没有链接。</p>
          ) : (
            draft.links.map((link, position) => (
              <div key={position} className="flex flex-wrap items-center gap-2">
                <select
                  className="select w-auto"
                  value={link.type}
                  onChange={(event) => {
                    const links = [...draft.links];
                    links[position] = { ...link, type: event.target.value };
                    setDraft({ ...draft, links });
                  }}
                >
                  {LINK_TYPE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className="input min-w-0 flex-1"
                  placeholder="显示名称"
                  value={link.label}
                  onChange={(event) => {
                    const links = [...draft.links];
                    links[position] = { ...link, label: event.target.value };
                    setDraft({ ...draft, links });
                  }}
                />
                <input
                  className="input min-w-0 flex-1"
                  placeholder="https://…"
                  value={link.url}
                  onChange={(event) => {
                    const links = [...draft.links];
                    links[position] = { ...link, url: event.target.value };
                    setDraft({ ...draft, links });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  aria-label="删除链接"
                  onClick={() => setDraft({ ...draft, links: draft.links.filter((_, index) => index !== position) })}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-bold">作品（精选在前台单独成组）</h3>
          {!person ? (
            <p className="muted text-xs">先创建人物，保存后即可添加作品。</p>
          ) : person.items.length === 0 ? (
            <p className="muted text-xs">还没有作品。</p>
          ) : (
            person.items.map((item) => <ItemRow key={item.id} item={item} onRefresh={onRefresh} onError={onError} />)
          )}
          {person ? <NewItemForm personId={person.id} onRefresh={onRefresh} onError={onError} onDone={onDone} /> : null}
        </section>
      </div>
    </Modal>
  );
}

function NewItemForm({
  personId,
  onRefresh,
  onError,
  onDone,
}: {
  personId: number;
  onRefresh: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ShowcaseItemKind>("website");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [featured, setFeatured] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!title.trim()) {
      onError("请填写作品标题");
      return;
    }
    setBusy(true);
    try {
      await createShowcaseItem(personId, {
        title: title.trim(),
        kind,
        url: url.trim() || null,
        description: description.trim() || null,
        featured,
      });
      setTitle("");
      setUrl("");
      setDescription("");
      setFeatured(false);
      onDone("已添加作品");
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : "添加失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-[var(--color-edge)] p-3">
      <span className="text-xs font-semibold text-[var(--color-muted)]">添加作品</span>
      <div className="flex flex-wrap gap-2">
        <input
          className="input min-w-0 flex-1"
          placeholder="作品标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <select
          className="select w-auto"
          value={kind}
          onChange={(event) => setKind(event.target.value as ShowcaseItemKind)}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <input
        className="input"
        placeholder="作品链接 https://…"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <textarea
        className="input min-h-[60px] resize-y"
        placeholder="一句话介绍（可选）"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <div className="flex items-center gap-3">
        <label className="chip">
          <input type="checkbox" checked={featured} onChange={(event) => setFeatured(event.target.checked)} />
          设为精选
        </label>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void add()}>
          {busy ? "添加中…" : "添加"}
        </button>
      </div>
    </div>
  );
}

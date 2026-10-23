import { useState } from "react";
import { Link } from "react-router";
import { setProfileGalleryPublished, type ProfileGalleryData, type ProfileGallerySummary } from "../api";
import { useApi } from "../hooks";
import { EmptyPanel, ErrorPanel, PageHeader, SkeletonPanel } from "../components/ui";
import { useDialogs } from "../components/Dialogs";
import { formatDateTime } from "../format";

function ownerLabel(profile: ProfileGallerySummary): string {
  const owner = profile.owner;
  if (!owner) return "未知用户";
  const name = [owner.firstName, owner.lastName].filter(Boolean).join(" ");
  return name || (owner.username ? `@${owner.username}` : `用户 ${owner.telegramUserId}`);
}

function ProfileTile({
  profile,
  onToggle,
  onCoverChange,
  busy,
}: {
  profile: ProfileGallerySummary;
  onToggle: (profile: ProfileGallerySummary) => void;
  onCoverChange: (profile: ProfileGallerySummary, mediaAssetId: number) => void;
  busy: boolean;
}) {
  return (
    <article className="flex flex-col gap-3 card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-[var(--color-ink)]">{ownerLabel(profile)}</h3>
          <p className="truncate text-xs text-[var(--color-muted)]">
            {formatDateTime(profile.createdAt)}
            {profile.publishedAt ? ` · 发布于 ${formatDateTime(profile.publishedAt)}` : ""}
          </p>
          {profile.owner ? (
            <p className="truncate text-xs text-[var(--color-muted)]">
              {profile.owner.username ? `@${profile.owner.username}` : "无用户名"} · Telegram ID{" "}
              {profile.owner.telegramUserId}
            </p>
          ) : null}
        </div>
        <span className={profile.publishedAt ? "badge badge-green" : "badge badge-gray"}>
          {profile.publishedAt ? `已公开${profile.showUsername ? " · 显示用户名" : " · 隐藏用户名"}` : "未公开"}
        </span>
      </div>

      {profile.images.length > 0 ? (
        <div className={profile.images.length > 1 ? "grid grid-cols-2 gap-1" : ""}>
          {profile.images.map((image) => (
            <img
              key={image.mediaAssetId}
              src={image.url}
              alt="个人资料照片"
              loading="lazy"
              className="h-52 w-full rounded-xl object-cover"
            />
          ))}
        </div>
      ) : (
        <div className="grid h-28 place-items-center rounded-xl bg-[var(--surface-muted)] text-xs text-[var(--color-muted)]">
          无照片
        </div>
      )}

      {profile.images.length > 1 ? (
        <label className="text-xs text-[var(--color-muted)]">
          画廊封面
          <select
            className="select mt-1 w-full text-sm"
            defaultValue={String(profile.images[0]?.mediaAssetId ?? "")}
            disabled={busy}
            onChange={(event) => onCoverChange(profile, Number(event.target.value))}
          >
            {profile.images.map((image, index) => (
              <option key={image.mediaAssetId} value={image.mediaAssetId}>
                图片 {index + 1}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <dl className="space-y-1.5 text-sm">
        {profile.fields.map((field) => (
          <div key={field.questionId} className="grid grid-cols-1 sm:grid-cols-[100px_minmax(0,1fr)] gap-x-2">
            <dt className="text-[var(--color-muted)]">{field.title}</dt>
            <dd className="whitespace-pre-wrap break-words text-[var(--color-ink)]">{field.value}</dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        disabled={busy}
        onClick={() => onToggle(profile)}
        className={profile.publishedAt ? "btn btn-sm" : "btn btn-primary btn-sm"}
      >
        {busy ? "处理中…" : profile.publishedAt ? "从画廊下架" : "管理员发布"}
      </button>
      <Link
        className="text-xs text-[var(--color-primary)] hover:underline"
        to={`/surveys/${profile.surveyId}/responses/${profile.id}`}
      >
        查看完整答卷
      </Link>
    </article>
  );
}

export function ProfileGalleryPage() {
  const [view, setView] = useState<"all" | "published">("all");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const pageSize = 20;
  const { toast } = useDialogs();
  const { data, error, retry } = useApi<ProfileGalleryData>(
    `/api/admin/profile-gallery?view=${view}&offset=${page * pageSize}&limit=${pageSize}${appliedSearch ? `&search=${encodeURIComponent(appliedSearch)}` : ""}`,
  );

  const toggle = async (profile: ProfileGallerySummary) => {
    try {
      setBusyId(profile.id);
      await setProfileGalleryPublished(profile.id, !profile.publishedAt);
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "操作失败", variant: "error" });
      retry();
    } finally {
      setBusyId(null);
    }
  };

  const changeCover = async (profile: ProfileGallerySummary, coverMediaId: number) => {
    try {
      setBusyId(profile.id);
      await setProfileGalleryPublished(profile.id, Boolean(profile.publishedAt), { coverMediaId });
      retry();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : "封面设置失败", variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="个人画廊"
        actions={
          <div className="flex gap-2">
            {(["all", "published"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setView(option);
                  setPage(0);
                }}
                className={view === option ? "btn btn-sm" : "btn btn-sm"}
              >
                {option === "all" ? "全部" : "已发布"}
              </button>
            ))}
          </div>
        }
      />
      {data ? (
        <p className="text-sm text-[var(--color-muted)]">
          已完成 {data.total} 份 · 已公开 {data.publishedTotal} 份
        </p>
      ) : null}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setAppliedSearch(search.trim());
        }}
      >
        <input
          className="input min-w-0 flex-1 sm:max-w-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索用户名、姓名或答卷编号"
        />
        <button type="submit" className="btn">
          搜索
        </button>
        {appliedSearch ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSearch("");
              setAppliedSearch("");
              setPage(0);
            }}
          >
            清除
          </button>
        ) : null}
      </form>
      {error ? (
        <ErrorPanel error={error} onRetry={retry} />
      ) : !data ? (
        <SkeletonPanel lines={6} />
      ) : data.surveyId === null ? (
        <EmptyPanel text="个人画廊还未启用：请到「系统设置」选择一份问卷作为个人画廊问卷。" />
      ) : data.items.length === 0 ? (
        <EmptyPanel text={view === "published" ? "还没有已发布的个人资料。" : "还没有个人资料答卷。"} />
      ) : (
        <>
          <p className="text-xs text-[var(--color-muted)]">
            问卷：{data.surveyTitle}（#{data.surveyId}） · 共 {total} 条
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((profile) => (
              <ProfileTile
                key={profile.id}
                profile={profile}
                busy={busyId === profile.id}
                onToggle={(item) => void toggle(item)}
                onCoverChange={(item, coverMediaId) => void changeCover(item, coverMediaId)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-[var(--color-muted)]">
            <span>
              第 {page + 1}/{totalPages} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="btn btn-sm"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((current) => current + 1)}
                className="btn btn-sm"
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

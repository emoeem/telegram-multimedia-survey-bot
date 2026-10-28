import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Plus, Save, Trash2 } from "lucide-react";
import {
  createSurveyCategory,
  deleteSurveyCategory,
  listSurveyCategories,
  updateSurveyCategory,
  type SurveyCategoryDto,
} from "../api";
import { useApi } from "../hooks";
import { useDialogs } from "../components/Dialogs";
import { EmptyPanel, ErrorPanel, SkeletonPanel } from "../components/ui";

/**
 * 分类管理（0087）。
 *
 * 这一页存在的理由很具体：公开目录里 88 份问卷平铺成一张无限长的列表，
 * 用户不知道从哪份开始。分类是运营手里那把「把它收成 7 个抽屉」的刀，
 * 所以它必须能自己改名、调顺序、删掉——而不是写死在前端的一个枚举里。
 *
 * 批量归类不放在这里，放在「问卷」页的勾选操作条上：整理 88 份问卷时，
 * 人的动作是「在列表里扫一遍、勾上、一起归类」，站在分类页想「这个分类
 * 该有哪些问卷」是反的。
 */

interface DraftRow {
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
}

function toDraft(category: SurveyCategoryDto): DraftRow {
  return {
    name: category.name,
    slug: category.slug,
    description: category.description,
    sortOrder: category.sortOrder,
  };
}

export function CategoriesPage() {
  const { data, error, retry } = useApi<{ items: SurveyCategoryDto[] }>("/api/admin/survey-categories");
  const { confirm, toast } = useDialogs();
  const [drafts, setDrafts] = useState<Record<number, DraftRow>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 服务端数据落地后重建草稿；用户正在编辑的那一格由 dirty 集合保护。
  const categories = useMemo(() => data?.items ?? [], [data]);
  useEffect(() => {
    const next: Record<number, DraftRow> = {};
    for (const category of categories) next[category.id] = toDraft(category);
    setDrafts(next);
  }, [categories]);

  const totalClassified = categories.reduce((sum, category) => sum + category.count, 0);

  const patchDraft = (id: number, patch: Partial<DraftRow>) => {
    const fallback = categories.find((category) => category.id === id);
    setDrafts((current) => {
      const base = current[id] ?? (fallback ? toDraft(fallback) : null);
      if (!base) return current;
      return { ...current, [id]: { ...base, ...patch } };
    });
  };

  const save = async (category: SurveyCategoryDto) => {
    const draft = drafts[category.id];
    if (!draft || busyId !== null) return;
    setBusyId(category.id);
    try {
      await updateSurveyCategory(category.id, {
        name: draft.name,
        slug: draft.slug,
        description: draft.description,
        sortOrder: draft.sortOrder,
      });
      toast({ message: `已保存「${draft.name}」`, variant: "success" });
      retry();
    } catch (requestError) {
      toast({
        message: requestError instanceof Error ? requestError.message : "保存失败",
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (category: SurveyCategoryDto) => {
    const ok = await confirm({
      title: "删除分类",
      message:
        category.count > 0
          ? `「${category.name}」下有 ${category.count} 份问卷。删除后它们会回到「未分类」，问卷本身不受影响。`
          : `确定删除「${category.name}」？`,
      confirmLabel: "删除",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(category.id);
    try {
      await deleteSurveyCategory(category.id);
      toast({ message: "分类已删除", variant: "success" });
      retry();
    } catch (requestError) {
      toast({
        message: requestError instanceof Error ? requestError.message : "删除失败",
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createSurveyCategory({
        name,
        ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
        sortOrder: (categories.at(-1)?.sortOrder ?? 0) + 10,
      });
      setNewName("");
      setNewDescription("");
      toast({ message: `已创建「${name}」`, variant: "success" });
      retry();
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="admin-page-intro">
        <div>
          <h2>分类</h2>
          <p>把问卷收进几个抽屉，公开目录会按这里的顺序显示筛选条</p>
        </div>
      </div>

      <section className="card">
        <h3 className="mb-1 text-base font-semibold">新建分类</h3>
        <p className="mb-4 text-sm text-[var(--color-muted)]">
          slug 是链接里的标识，留空自动生成；说明只显示在管理端，用来提醒同事这个抽屉装什么。
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
          <input
            className="input"
            placeholder="分类名，如「情景剧情」"
            maxLength={20}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
          />
          <input
            className="input"
            placeholder="说明（可选）"
            maxLength={120}
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
          />
          <button className="btn btn-primary" disabled={creating || !newName.trim()} onClick={() => void create()}>
            {creating ? (
              "创建中…"
            ) : (
              <>
                <Plus className="h-4 w-4" />
                新建
              </>
            )}
          </button>
        </div>
        {createError ? <div className="mt-2 text-sm text-[var(--app-danger)]">新建失败：{createError}</div> : null}
      </section>

      <section className="card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">全部分类</h3>
            <p className="mt-0.5 text-sm text-[var(--color-muted)]">
              {categories.length} 个分类 · 已归类 {totalClassified} 份问卷
            </p>
          </div>
          <Link to="/surveys?category=none" className="btn btn-sm">
            查看未分类问卷
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={retry} />
        ) : !data ? (
          <SkeletonPanel lines={4} />
        ) : categories.length === 0 ? (
          <EmptyPanel text="还没有分类。公开目录会退化成一张长列表——先建几个抽屉吧。" />
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="w-20">排序</th>
                    <th className="w-40">名称</th>
                    <th className="w-36">slug</th>
                    <th>说明</th>
                    <th className="w-24">问卷</th>
                    <th className="w-28">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((category) => {
                    const draft = drafts[category.id] ?? toDraft(category);
                    return (
                      <tr key={category.id}>
                        <td data-label="排序">
                          <input
                            className="input w-16"
                            type="number"
                            value={draft.sortOrder}
                            onChange={(event) => patchDraft(category.id, { sortOrder: Number(event.target.value) })}
                          />
                        </td>
                        <td data-label="名称">
                          <input
                            className="input"
                            value={draft.name}
                            maxLength={20}
                            onChange={(event) => patchDraft(category.id, { name: event.target.value })}
                          />
                        </td>
                        <td data-label="slug">
                          <input
                            className="input font-mono text-xs"
                            value={draft.slug}
                            onChange={(event) => patchDraft(category.id, { slug: event.target.value })}
                          />
                        </td>
                        <td data-label="说明">
                          <input
                            className="input"
                            placeholder="这个抽屉装什么"
                            maxLength={120}
                            value={draft.description}
                            onChange={(event) => patchDraft(category.id, { description: event.target.value })}
                          />
                        </td>
                        <td className="text-sm" data-label="问卷">
                          <Link to={`/surveys?category=${category.id}`} className="link">
                            {category.count} 份
                          </Link>
                        </td>
                        <td data-label="操作">
                          <div className="flex items-center gap-1.5">
                            <button
                              className="btn btn-sm"
                              title="保存"
                              disabled={busyId !== null}
                              onClick={() => void save(category)}
                            >
                              <Save className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              title="删除"
                              disabled={busyId !== null}
                              onClick={() => void remove(category)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 sm:hidden">
              {categories.map((category) => {
                const draft = drafts[category.id] ?? toDraft(category);
                return (
                  <div key={category.id} className="rounded-lg border border-[var(--color-edge)] p-4">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{category.name}</strong>
                      <Link to={`/surveys?category=${category.id}`} className="text-sm text-[var(--color-muted)]">
                        {category.count} 份
                      </Link>
                    </div>
                    <input
                      className="input mt-2"
                      value={draft.name}
                      maxLength={20}
                      onChange={(event) => patchDraft(category.id, { name: event.target.value })}
                    />
                    <input
                      className="input mt-2 font-mono text-xs"
                      value={draft.slug}
                      onChange={(event) => patchDraft(category.id, { slug: event.target.value })}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        className="input w-20"
                        type="number"
                        value={draft.sortOrder}
                        onChange={(event) => patchDraft(category.id, { sortOrder: Number(event.target.value) })}
                      />
                      <button
                        className="btn btn-sm flex-1"
                        disabled={busyId !== null}
                        onClick={() => void save(category)}
                      >
                        <Save className="h-3.5 w-3.5" />
                        保存
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busyId !== null}
                        onClick={() => void remove(category)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

import type { ProfileGalleryField, ProfileGalleryItem } from "./profile-gallery.service";
import {
  createShowcasePerson,
  getShowcasePersonByResponseId,
  type ShowcasePersonInput,
} from "../db/repositories/showcase.repository";
import { SHOWCASE_LIMITS } from "./showcase.service";

/**
 * 画廊答卷 → 展示页（showcase_persons）。
 *
 * 参与者只能通过这个入口生成「草稿」：展示区是策展空间，是否公开由管理员在
 * 后台决定。映射是按题目标题做的启发式（名字 / 一句话 / 简介 / 标签），任何
 * 一项都允许缺失——展示页只要求一个非空昵称，其余字段落到默认值。
 */

const NAME_PATTERN = /姓名|名字|昵称|称呼|name/i;
const SUBTITLE_PATTERN = /签名|一句话|副标题|职业|身份|tagline|subtitle/i;
const BIO_PATTERN = /简介|自我介绍|介绍|关于|about|bio|描述|desc/i;
const TAG_PATTERN = /标签|tag|兴趣|关键词/;

/** Trim to a hard character budget; the showcase column limits are the target. */
function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

function pickField(fields: ProfileGalleryField[], pattern: RegExp): ProfileGalleryField | null {
  for (const field of fields) {
    if (pattern.test(field.title) && field.value.trim()) return field;
  }
  return null;
}

function splitTags(value: string): string[] {
  const seen: string[] = [];
  for (const part of value.split(/[,，、;；/#\s]+/)) {
    const tag = clamp(part.replace(/^#+|#+$/g, ""), SHOWCASE_LIMITS.tag);
    if (!tag || seen.includes(tag)) continue;
    seen.push(tag);
    if (seen.length >= SHOWCASE_LIMITS.maxTags) break;
  }
  return seen;
}

export interface ShowcaseProfileMapping {
  fields: Omit<ShowcasePersonInput, "published" | "ownerUserId">;
}

/** Pure mapping so it can be unit tested without a database. */
export function mapProfileToShowcasePerson(profile: ProfileGalleryItem): ShowcaseProfileMapping {
  const fields = profile.fields.filter((field) => field.value.trim().length > 0);

  const nameField = pickField(fields, NAME_PATTERN);
  const subtitleField = pickField(fields, SUBTITLE_PATTERN);
  const bioField = pickField(fields, BIO_PATTERN);
  const tagField = pickField(fields, TAG_PATTERN);

  const ownerName = profile.owner?.firstName ?? profile.owner?.username ?? null;
  const name = clamp(nameField?.value ?? ownerName ?? `资料卡 #${profile.responseId}`, SHOWCASE_LIMITS.name);

  // Skip the fields already consumed so the 简介 does not repeat the 昵称.
  const consumed = new Set(
    [nameField, subtitleField, tagField].filter((field): field is ProfileGalleryField => field !== null).map((f) => f.questionId),
  );
  const descriptionParts = bioField
    ? [bioField.value]
    : fields
        .filter((field) => !consumed.has(field.questionId))
        .sort((a, b) => b.value.length - a.value.length)
        .slice(0, 3)
        .map((field) => field.value);
  const description = descriptionParts.length
    ? clamp(descriptionParts.join("\n"), SHOWCASE_LIMITS.description) || null
    : null;

  const images = profile.images ?? [];
  return {
    fields: {
      name,
      subtitle: subtitleField ? clamp(subtitleField.value, SHOWCASE_LIMITS.subtitle) : null,
      description,
      tags: tagField ? splitTags(tagField.value) : [],
      illustrationMediaId: images[0]?.mediaAssetId ?? null,
      backgroundMediaId: images[1]?.mediaAssetId ?? null,
      avatarMediaId: null,
      surveyId: profile.surveyId,
      responseId: profile.responseId,
    },
  };
}

export interface SyncShowcasePersonResult {
  personId: number;
  /** true = 本次新建；false = 已经存在（内容以管理员/首次生成为准，不覆盖）。 */
  created: boolean;
  published: boolean;
}

/**
 * Creates the draft showcase page for a published gallery response, or returns
 * the one that already exists.
 *
 * An existing page is never overwritten: an operator may have renamed, trimmed
 * or featured it, and a participant re-clicking a button must not undo that.
 */
export async function syncShowcasePersonFromProfile(
  db: D1Database,
  profile: ProfileGalleryItem,
  options: { ownerUserId: number | null },
): Promise<SyncShowcasePersonResult> {
  const existing = await getShowcasePersonByResponseId(db, profile.responseId);
  if (existing) {
    return { personId: existing.id, created: false, published: existing.published };
  }
  const { fields } = mapProfileToShowcasePerson(profile);
  const personId = await createShowcasePerson(db, {
    ...fields,
    ownerUserId: options.ownerUserId,
    // 参与者只能生成草稿；公开与否由管理员在后台决定。
    published: false,
  });
  return { personId, created: true, published: false };
}

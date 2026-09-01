import { describe, expect, it } from "vitest";
import {
  buildIdentityCardProfile,
  isIdentityCardTemplateId,
  resolveIdentityCardTemplate,
} from "../../../src/services/identity-card-report.service";
import {
  GALLERY_REPORT_TEMPLATE,
  IDENTITY_REPORT_TEMPLATE,
  MINIMAL_REPORT_TEMPLATE,
} from "../../../src/services/report/template";
import type { IdentityProfileRecord } from "../../../src/db/repositories/identity-card.repository";

function profile(overrides: Partial<IdentityProfileRecord> = {}): IdentityProfileRecord {
  return {
    id: 7,
    userId: 3,
    name: "暮色蔷薇",
    nickname: "蔷薇",
    age: 27,
    identityLabel: "夜行者",
    description: "喜欢夜晚与仪式感的自我介绍。",
    frontAssetId: 11,
    backAssetId: 12,
    backgroundAssetId: null,
    templateStyle: "identity",
    galleryPublished: false,
    galleryPublishedAt: null,
    cardAssetId: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("identity card report pipeline", () => {
  it("builds a profile snapshot with archive fields, tags and gallery captions", () => {
    const snapshot = buildIdentityCardProfile(profile());
    expect(snapshot.title).toBe("暮色蔷薇");
    expect(snapshot.subtitle).toBe("夜行者");
    expect(snapshot.tags).toEqual(["夜行者", "@蔷薇"]);
    expect(snapshot.fields.description).toMatchObject({ type: "long_text" });
    expect(snapshot.metadata.summary).toBe("喜欢夜晚与仪式感的自我介绍。");
    const archive = snapshot.metadata.profile as Array<{ label: string; value: string }>;
    expect(archive.map((item) => item.label)).toEqual(["姓名/代号", "昵称", "年龄", "身份标签"]);
    const gallery = snapshot.metadata.gallery as Array<{ caption: string }>;
    expect(gallery.map((item) => item.caption)).toEqual(["卡片正面", "卡片背面"]);
    expect(Object.keys(snapshot.images)).toEqual(["result.images.front_image", "result.images.back_image"]);
  });

  it("maps legacy WASM styles onto the closest card template", () => {
    expect(resolveIdentityCardTemplate("simple").id).toBe(MINIMAL_REPORT_TEMPLATE.id);
    expect(resolveIdentityCardTemplate("dark").name).toContain("杂志暗夜");
    expect(resolveIdentityCardTemplate("classic").name).toContain("身份档案");
    expect(resolveIdentityCardTemplate("unknown").id).toBe(IDENTITY_REPORT_TEMPLATE.id);
  });

  it("exposes the gallery card as the dark image-first layout", () => {
    const galleryCard = resolveIdentityCardTemplate("gallery");
    expect(galleryCard.id).toBe(GALLERY_REPORT_TEMPLATE.id);
    expect(galleryCard.layout).toBe("gallery");
    expect(galleryCard.blocks).toEqual(["cover", "gallery", "verdict"]);
    expect(galleryCard.css).toContain("gallery-single");
  });

  it("validates template ids and tolerates nullable optional fields", () => {
    expect(isIdentityCardTemplateId("minimal")).toBe(true);
    expect(isIdentityCardTemplateId("simple")).toBe(false);
    const bare = buildIdentityCardProfile(
      profile({ nickname: null, age: null, identityLabel: null, backAssetId: null }),
    );
    expect(bare.tags).toEqual(["个人资料卡"]);
    const archive = bare.metadata.profile as Array<{ label: string }>;
    expect(archive.map((item) => item.label)).toEqual(["姓名/代号"]);
    expect(Object.keys(bare.images)).toEqual(["result.images.front_image"]);
  });
});

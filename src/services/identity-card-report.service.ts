import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { IdentityProfileRecord } from "../db/repositories/identity-card.repository";
import { getCardTemplateById } from "../db/repositories/card-template.repository";
import { createMediaAsset } from "../db/repositories/media.repository";
import type { ResultProfileSnapshot } from "../result/schema";
import { KVMediaStore } from "./media/temporary-media-store";
import { buildReportViewModel, optimizeReportImagesInPage } from "./html-report-renderer.service";
import { cardTemplateContentFromIdentity, renderCardTemplatePng } from "./card-template-render.service";
import { resolveMediaAssetDataUrl, resolveReportProfileImages } from "./report/report-images.service";
import { buildResponsiveReportHtml } from "./report/web";
import {
  GALLERY_REPORT_TEMPLATE,
  IDENTITY_REPORT_TEMPLATE,
  MAGAZINE_DARK_TEMPLATE,
  MINIMAL_REPORT_TEMPLATE,
  REPORT_TEMPLATES,
  type ReportTemplateSpec,
} from "./report/template";

/**
 * Identity cards ("资料卡") render through the same web report pipeline as
 * survey reports: a ReportViewModel + report template -> responsive HTML ->
 * one fixed 900x1200 page captured as PNG. Each card style is a built-in
 * report template with a block list curated to fit a single card page.
 */
export const IDENTITY_CARD_TEMPLATES = [
  { id: "identity", label: "🏛 身份档案卡" },
  { id: "gallery", label: "🌆 深色影集卡" },
  { id: "magazine-dark", label: "🌃 杂志暗夜卡" },
  { id: "minimal", label: "⬜ 极简白卡" },
] as const;

export type IdentityCardTemplateId = (typeof IDENTITY_CARD_TEMPLATES)[number]["id"];

export function isIdentityCardTemplateId(value: string): value is IdentityCardTemplateId {
  return IDENTITY_CARD_TEMPLATES.some((template) => template.id === value);
}

/** Card-tuned template specs. Legacy WASM styles map onto them seamlessly. */
const CARD_FIT_CSS =
  // Keep the whole card inside one 900x1200 page: the shell's mobile branch
  // stacks the hero and blows up the verdict, so re-compact them here.
  `.report-page-shell .page{padding:32px 40px}` +
  `.report-page-shell .composition-region{margin-top:16px}` +
  // Card sections are self-explanatory; the big editorial chapter headings
  // only waste vertical space on a one-page card.
  `.report-page-shell .gallery-composition .chapter-heading,.report-page-shell .responses-composition .chapter-heading{display:none}` +
  `.report-page-shell .hero{display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:24px;align-items:center;min-height:0;padding:24px 0;text-align:left}` +
  `.report-page-shell .hero-avatar{position:static;width:130px;height:130px;margin:0}` +
  `.report-page-shell .hero h1{font-size:40px;margin:10px 0 8px}` +
  `.report-page-shell .hero-thesis{font-size:16px}` +
  `.report-page-shell .report-cover{min-height:320px;padding:44px 0}` +
  `.report-page-shell .report-cover h1{font-size:44px}` +
  `.report-page-shell .gallery-composition{padding:20px 0}` +
  `.report-page-shell .gallery-single .gallery-item img{height:400px}` +
  `.report-page-shell .gallery-duo .gallery-item img{height:270px}` +
  `.report-page-shell .responses-composition{padding:18px 0}` +
  `.report-page-shell .compact-answer{padding:14px 16px}` +
  `.report-page-shell .compact-answer .question{margin-bottom:6px}` +
  `.report-page-shell .final-verdict{padding-top:36px;padding-bottom:32px}` +
  `.report-page-shell .final-verdict h2{font-size:30px;margin:14px 0 20px}` +
  `.report-page-shell .verdict-main{grid-template-columns:150px minmax(0,1fr);gap:24px}` +
  `.report-page-shell .verdict-score strong{font-size:54px}` +
  `.report-page-shell .verdict-pillars{grid-template-columns:repeat(3,1fr);gap:18px;margin-top:26px}` +
  `.report-page-shell .closing-statement{margin-top:22px}`;

export function resolveIdentityCardTemplate(style: string): ReportTemplateSpec {
  if (style === "identity") {
    return {
      ...IDENTITY_REPORT_TEMPLATE,
      name: "身份档案卡",
      blocks: ["hero", "gallery", "responses", "verdict"],
      css: `${IDENTITY_REPORT_TEMPLATE.css ?? ""}${CARD_FIT_CSS}`,
      sections: [{ kind: "hero" }, { kind: "gallery" }, { kind: "answers", presentation: "list" }, { kind: "verdict" }],
    };
  }
  if (style === "gallery") {
    return {
      ...GALLERY_REPORT_TEMPLATE,
      name: "深色影集卡",
      blocks: ["cover", "gallery", "verdict"],
      css: `${GALLERY_REPORT_TEMPLATE.css ?? ""}${CARD_FIT_CSS}`,
      sections: [{ kind: "cover" }, { kind: "gallery" }, { kind: "verdict" }],
    };
  }
  if (style === "magazine-dark") {
    return {
      ...MAGAZINE_DARK_TEMPLATE,
      name: "杂志暗夜卡",
      blocks: ["hero", "gallery", "responses", "verdict"],
      css: `${MAGAZINE_DARK_TEMPLATE.css ?? ""}${CARD_FIT_CSS}`,
      sections: [{ kind: "hero" }, { kind: "gallery" }, { kind: "answers" }, { kind: "verdict" }],
    };
  }
  if (style === "minimal") {
    return {
      ...MINIMAL_REPORT_TEMPLATE,
      name: "极简白卡",
      css: `${MINIMAL_REPORT_TEMPLATE.css ?? ""}.report-cover,header.hero{border-bottom:1px solid var(--border)}`,
    };
  }
  // Legacy WASM-era styles keep rendering: map them onto the closest card.
  const legacy: Record<string, IdentityCardTemplateId> = {
    simple: "minimal",
    dark: "magazine-dark",
    classic: "identity",
  };
  const mapped = legacy[style] ?? "identity";
  return resolveIdentityCardTemplate(mapped);
}

export function buildIdentityCardProfile(identity: IdentityProfileRecord): ResultProfileSnapshot {
  const fields: ResultProfileSnapshot["fields"] = {
    name: { id: "name", type: "text", value: identity.name },
    nickname: { id: "nickname", type: "text", value: identity.nickname ?? "" },
    age: { id: "age", type: "number", value: identity.age ?? "" },
    identity_label: { id: "identity_label", type: "text", value: identity.identityLabel ?? "" },
    description: { id: "description", type: "long_text", value: identity.description ?? "" },
  };
  const images: ResultProfileSnapshot["images"] = {
    // Canonical "result.images.*" keys so buildReportViewModel binds the front
    // photo as the hero avatar directly instead of via the gallery fallback.
    "result.images.front_image": { mediaAssetId: identity.frontAssetId },
  };
  if (identity.backAssetId) images["result.images.back_image"] = { mediaAssetId: identity.backAssetId };
  const archive: Array<{ label: string; value: string }> = [
    { label: "姓名/代号", value: identity.name },
    ...(identity.nickname ? [{ label: "昵称", value: identity.nickname }] : []),
    ...(identity.age !== null ? [{ label: "年龄", value: String(identity.age) }] : []),
    ...(identity.identityLabel ? [{ label: "身份标签", value: identity.identityLabel }] : []),
  ];
  const tags = [identity.identityLabel ?? "个人资料卡", ...(identity.nickname ? [`@${identity.nickname}`] : [])];
  return {
    resultType: "identity_card",
    title: identity.name,
    subtitle: identity.identityLabel ?? "个人资料卡",
    fields,
    stats: [],
    tags,
    images,
    metadata: {
      created_at: identity.createdAt,
      summary: identity.description ?? "",
      gallery: [{ caption: "卡片正面" }, ...(identity.backAssetId ? [{ caption: "卡片背面" }] : [])],
      profile: archive,
    },
    schemaVersion: 1,
  };
}

export interface IdentityCardRenderEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  MEDIA_KV?: KVNamespace;
  MEDIA?: R2Bucket;
  BROWSER: BrowserWorker;
}

function withPageShell(html: string): string {
  return html.replace('class="report-layout-', 'class="report-page-shell report-layout-');
}

/** Renders one identity card as a single 900x1200 PNG via the web report pipeline. */
export async function renderIdentityCardReportPng(
  env: IdentityCardRenderEnvironment,
  identity: IdentityProfileRecord,
  template: ReportTemplateSpec = resolveIdentityCardTemplate(identity.templateStyle),
): Promise<Uint8Array> {
  // Admin-designed card face templates ("custom:<id>") bypass the report
  // template system entirely and render the slot-based card canvas instead.
  const customMatch = /^custom:(\d+)$/.exec(identity.templateStyle);
  if (customMatch) {
    const cardTemplate = await getCardTemplateById(env.DB, Number(customMatch[1]));
    if (!cardTemplate) throw new Error("卡面模板不存在或已删除");
    const frontImage = await resolveMediaAssetDataUrl(env, identity.frontAssetId);
    const backImage = identity.backAssetId ? await resolveMediaAssetDataUrl(env, identity.backAssetId) : null;
    return renderCardTemplatePng(
      env,
      cardTemplate,
      cardTemplateContentFromIdentity(identity, { frontImage, backImage }),
    );
  }
  const profileSnapshot = buildIdentityCardProfile(identity);
  const images = await resolveReportProfileImages(env, profileSnapshot);
  if (Object.keys(images).length === 0) {
    console.warn("Identity card render resolved no images", {
      identityId: identity.id,
      frontAssetId: identity.frontAssetId,
      backAssetId: identity.backAssetId,
    });
  }
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    try {
      // Downscale inlined photos before composing the HTML: Browser
      // Rendering's chromium runs on a tight memory budget, and cards built
      // from multi-megabyte originals rasterize as a solid black screenshot.
      const optimizedImages = await optimizeReportImagesInPage(page, images, {
        maxImageDimension: { thumbnail: 400, card: 800, gallery: 1200, featured: 1600, hero: 1600 },
      });
      const viewModel = buildReportViewModel(profileSnapshot, optimizedImages);
      // renderGalleryBlock drops entries matching the hero avatar URL (survey
      // reports avoid repeating the portrait), but a card's front photo IS the
      // content. A URL fragment makes the gallery copy a distinct string without
      // changing the decoded image, so the photo shows full-size in the gallery.
      viewModel.gallery = viewModel.gallery.map((item) => ({ ...item, url: `${item.url}#card-gallery` }));
      const html = withPageShell(
        buildResponsiveReportHtml(
          viewModel,
          {
            surveyTitle: "个人资料卡",
            completedAt: identity.createdAt.slice(0, 16).replace("T", " "),
            reportId: `卡 #${identity.id}`,
          },
          template,
        ),
      );
      await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
      await page.evaluate(
        "Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))",
      );
      const brokenImages = await page.evaluate(
        "Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length",
      );
      if (typeof brokenImages === "number" && brokenImages > 0) {
        console.warn("Identity card has undecodable images", { identityId: identity.id, brokenImages });
      }
      // The card is one fixed 900x1200 page; if a template overflows it,
      // scale the whole composition down instead of cutting the bottom off.
      // The scaled box must give up its fixed height, or its own
      // overflow:hidden would clip the freshly-fitted content.
      const zoom = await page.evaluate(
        `(()=>{const shell=document.querySelector('.report-page-shell');const target=shell?.querySelector('.page')??document.body;const overflow=Math.max(target.scrollHeight,document.documentElement.scrollHeight)-1200;if(overflow<=2)return 1;const scale=Math.max(0.5,Math.min(0.98,1200/(target.scrollHeight)));target.style.zoom=String(scale);target.style.height="auto";return scale})()`,
      );
      if (typeof zoom === "number" && zoom < 1) {
        console.warn("Identity card content overflowed; scaled to fit", { identityId: identity.id, zoom });
      }
      return new Uint8Array(await page.screenshot({ type: "png" }));
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Stores a rendered card PNG in MEDIA_KV so the gallery and admin reuse it. */
export async function storeIdentityCardPng(
  env: { DB: D1Database; MEDIA_KV?: KVNamespace },
  identityId: number,
  png: Uint8Array,
): Promise<number | null> {
  if (!env.MEDIA_KV) return null;
  const storageKey = `identity-cards/${identityId}/${Date.now()}.png`;
  await new KVMediaStore(env.MEDIA_KV).put({ storageKey, bytes: png, contentType: "image/png" });
  const asset = await createMediaAsset(env.DB, {
    scope: "generated_result",
    mediaType: "photo",
    storageKind: "temporary",
    storageKey,
    mimeType: "image/png",
    fileName: `identity-card-${identityId}.png`,
    fileSize: png.byteLength,
    width: 900,
    height: 1200,
  });
  return asset.id;
}

export function identityCardTemplateName(style: string): string {
  if (style.startsWith("custom:")) return "自定义卡面";
  return (
    IDENTITY_CARD_TEMPLATES.find((template) => template.id === style)?.label ?? REPORT_TEMPLATES[style]?.name ?? style
  );
}

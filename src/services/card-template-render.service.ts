import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import {
  CARD_CANVAS_HEIGHT,
  CARD_CANVAS_WIDTH,
  CARD_TEMPLATE_SAMPLE_VALUES,
  type CardSlot,
  type CardTemplateDefinition,
} from "../card-template/model";
import type { CardTemplateRecord } from "../db/repositories/card-template.repository";
import type { IdentityProfileRecord } from "../db/repositories/identity-card.repository";
import { RESULT_VISUAL_EMOJI_FONT, RESULT_VISUAL_FONT } from "./result-visual-font";
import { optimizeReportImagesInPage } from "./html-report-renderer.service";
import { resolveMediaAssetDataUrl } from "./report/report-images.service";

export interface CardTemplateRenderEnvironment {
  DB: D1Database;
  BOT_TOKEN: string;
  MEDIA_KV?: KVNamespace;
  MEDIA?: R2Bucket;
  BROWSER: BrowserWorker;
}

/** Text values a template can bind to; images arrive separately as data URLs. */
export interface CardTemplateContent {
  values: Partial<Record<string, string>>;
  frontImage?: string | null;
  backImage?: string | null;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

const fontFaceCss =
  `@font-face{font-family:CardSans;src:url(${bytesToDataUrl(RESULT_VISUAL_FONT, "font/ttf")}) format("truetype");font-weight:400;font-style:normal;font-display:block}` +
  `@font-face{font-family:CardEmoji;src:url(${bytesToDataUrl(RESULT_VISUAL_EMOJI_FONT, "font/ttf")}) format("truetype");font-weight:400;font-style:normal;font-display:block;unicode-range:U+1F000-1FAFF,U+2600-27BF}`;

const FONT_STACK = `CardSans,CardEmoji,-apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
const SERIF_STACK = `Georgia,CardSans,CardEmoji,"Noto Serif CJK SC",serif`;

function slotText(slot: CardSlot, content: CardTemplateContent): string {
  if (slot.binding === "custom") return slot.customText ?? "";
  return content.values[slot.binding] ?? (CARD_TEMPLATE_SAMPLE_VALUES as Record<string, string>)[slot.binding] ?? "";
}

function renderSlot(slot: CardSlot, content: CardTemplateContent): string {
  const box =
    `position:absolute;left:${slot.x}px;top:${slot.y}px;width:${slot.w}px;height:${slot.h}px;` +
    `overflow:hidden;${slot.opacity !== undefined ? `opacity:${slot.opacity};` : ""}` +
    `${slot.rotate ? `transform:rotate(${slot.rotate}deg);` : ""}`;
  if (slot.kind === "image") {
    const source = slot.binding === "back_image" ? content.backImage : content.frontImage;
    const radius = slot.radius ? `border-radius:${slot.radius}px;` : "";
    if (!source) {
      return `<div style="${box}${radius}background:rgba(128,128,128,.18);border:1px dashed rgba(128,128,128,.5);"></div>`;
    }
    return `<div style="${box}${radius}"><img src="${source}" alt="" style="width:100%;height:100%;object-fit:${slot.fit ?? "cover"};${radius}display:block" /></div>`;
  }
  const text = slotText(slot, content);
  if (!text.trim()) return "";
  const style =
    `${box}display:flex;flex-direction:column;justify-content:center;` +
    `font-family:${slot.fontFamily === "serif" ? SERIF_STACK : FONT_STACK};` +
    `font-size:${slot.fontSize ?? 28}px;font-weight:${slot.fontWeight ?? 400};` +
    `color:${slot.color ?? "#111111"};text-align:${slot.align ?? "left"};` +
    `line-height:${slot.lineHeight ?? 1.4};white-space:pre-wrap;word-break:break-word;`;
  const alignItems = slot.align === "center" ? "center" : slot.align === "right" ? "flex-end" : "flex-start";
  return `<div style="${style}align-items:${alignItems}"><div>${escapeHtml(text)}</div></div>`;
}

/** Builds the fixed-canvas card HTML. The disclaimer is always drawn. */
export function buildCardTemplateHtml(
  definition: CardTemplateDefinition,
  backgroundDataUrl: string | null,
  content: CardTemplateContent,
  options: { width?: number; height?: number } = {},
): string {
  const width = options.width ?? CARD_CANVAS_WIDTH;
  const height = options.height ?? CARD_CANVAS_HEIGHT;
  const background = backgroundDataUrl
    ? `<img src="${backgroundDataUrl}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />`
    : "";
  const slots = definition.slots.map((slot) => renderSlot(slot, content)).join("");
  const disclaimer = `<div style="position:absolute;right:12px;bottom:10px;z-index:10;font-family:${FONT_STACK};font-size:15px;line-height:1;color:#fff;background:rgba(0,0,0,.38);padding:4px 10px;border-radius:999px;letter-spacing:.04em">${escapeHtml(definition.disclaimerText)}</div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>${fontFaceCss}</style>
  <style>*{box-sizing:border-box}html,body{margin:0;padding:0}.card{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${definition.backgroundColor};font-family:${FONT_STACK}}</style>
</head>
<body>
  <div class="card">${background}${slots}${disclaimer}</div>
</body>
</html>`;
}

/** Binds an identity profile to template text values. */
export function cardTemplateContentFromIdentity(
  identity: IdentityProfileRecord,
  images: { frontImage?: string | null; backImage?: string | null },
): CardTemplateContent {
  return {
    values: {
      name: identity.name,
      nickname: identity.nickname ?? "",
      age: identity.age !== null ? String(identity.age) : "",
      identity_label: identity.identityLabel ?? "",
      description: identity.description ?? "",
      card_id: `NO.${String(identity.id).padStart(6, "0")}`,
      date: identity.createdAt.slice(0, 10),
    },
    frontImage: images.frontImage ?? null,
    backImage: images.backImage ?? null,
  };
}

/** Renders a custom card template to a fixed-size PNG via the browser binding. */
export async function renderCardTemplatePng(
  env: CardTemplateRenderEnvironment,
  template: Pick<
    CardTemplateRecord,
    "backgroundAssetId" | "backgroundColor" | "slots" | "disclaimerText" | "canvasWidth" | "canvasHeight"
  >,
  content: CardTemplateContent,
): Promise<Uint8Array> {
  const backgroundDataUrl = template.backgroundAssetId
    ? await resolveMediaAssetDataUrl(env, template.backgroundAssetId)
    : null;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    try {
      const optimizable: Record<string, string> = {};
      if (backgroundDataUrl) optimizable["template.background"] = backgroundDataUrl;
      if (content.frontImage) optimizable["result.images.front_image"] = content.frontImage;
      if (content.backImage) optimizable["result.images.back_image"] = content.backImage;
      const optimized = await optimizeReportImagesInPage(page, optimizable, {
        maxImageDimension: { thumbnail: 400, card: 800, gallery: 1200, featured: 1600, hero: 1600 },
      });
      const html = buildCardTemplateHtml(
        template,
        optimized["template.background"] ?? null,
        {
          values: content.values,
          frontImage: optimized["result.images.front_image"] ?? null,
          backImage: optimized["result.images.back_image"] ?? null,
        },
        { width: template.canvasWidth, height: template.canvasHeight },
      );
      await page.setViewport({ width: template.canvasWidth, height: template.canvasHeight, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate("document.fonts ? document.fonts.ready : Promise.resolve()");
      await page.evaluate(
        "Promise.all(Array.from(document.images).map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })))",
      );
      const brokenImages = await page.evaluate(
        "Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length",
      );
      if (typeof brokenImages === "number" && brokenImages > 0) {
        console.warn("Card template render has undecodable images", { brokenImages });
      }
      return new Uint8Array(await page.screenshot({ type: "png" }));
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

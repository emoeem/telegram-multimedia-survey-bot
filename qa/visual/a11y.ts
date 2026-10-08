import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

export interface A11yScanSummary {
  blocking: number;
  advisory: number;
  violations: Array<{ id: string; impact: string | null; nodes: number }>;
}

/** Visual regression is also our accessibility smoke gate. */
export async function scanA11y(page: Page, label: string): Promise<A11yScanSummary> {
  const result = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze();
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 4).map((node) => node.target.join(" ")),
  }));
  const blocking = violations.filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact));
  const advisory = violations.filter((violation) => !violation.impact || !BLOCKING_IMPACTS.has(violation.impact));
  if (advisory.length > 0) {
    console.warn(
      `[a11y] ${label}: advisory ${advisory.map((item) => `${item.id}(${item.impact ?? "unknown"}:${item.nodes})`).join(", ")}`,
    );
  }
  if (blocking.length > 0) {
    const contrastDetails = result.violations
      .filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact))
      .flatMap((violation) =>
        violation.nodes.slice(0, 4).map((node) => ({ id: violation.id, target: node.target, html: node.html })),
      );
    const styleDetails = await Promise.all(
      contrastDetails.map(async (detail) => {
        try {
          const style = await page.locator(detail.target.join(" ")).first().evaluate((element) => {
            const computed = getComputedStyle(element);
            return {
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              opacity: computed.opacity,
              success: computed.getPropertyValue("--color-success"),
            };
          });
          return { ...detail, style };
        } catch {
          return detail;
        }
      }),
    );
    console.error(
      `[a11y] ${label}: BLOCKING ${blocking.map((item) => `${item.id}(${item.impact ?? "unknown"}:${item.nodes}) [${item.targets.join(" | ")}]`).join(", ")}`,
      styleDetails,
    );
    throw new Error(`Accessibility gate failed for ${label}: ${blocking.map((item) => item.id).join(", ")}`);
  }
  return { blocking: 0, advisory: advisory.length, violations };
}

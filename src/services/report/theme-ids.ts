import type { ReportTheme } from "./themes";

/** Theme ids kept separate from the theme definitions to avoid circular
 * imports between template validation and the renderer. */
export const reportThemeIds: readonly ReportTheme[] = [
  "catppuccin-latte",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "tokyo-night",
  "dracula",
  "one-dark",
  "nord",
  "night-owl",
  "horizon",
  "cobalt2",
  "palenight",
  "solarized-dark",
  "gruvbox-dark",
  "monokai",
];

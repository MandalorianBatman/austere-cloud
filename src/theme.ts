// The site theme: dark by default for every visitor, light by choice. No script: `POST /theme` (src/web.ts) sets the cookie and the Worker renders `<html data-theme>` from it.

import { readCookie } from "./session";

export type Theme = "dark" | "light";

export const DEFAULT_THEME: Theme = "dark";
export const THEME_COOKIE = "austere_theme";
export const THEME_MAX_AGE_S = 365 * 24 * 60 * 60;

export function parseTheme(raw: string | null | undefined): Theme | null {
  return raw === "dark" || raw === "light" ? raw : null;
}

/** The visitor's theme: the cookie when it holds a known value, else dark. */
export function themeOf(request: Request): Theme {
  return parseTheme(readCookie(request, THEME_COOKIE)) ?? DEFAULT_THEME;
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

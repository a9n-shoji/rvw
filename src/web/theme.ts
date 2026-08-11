import { isThemePreference, type ThemePreference } from "../shared/preferences.js";

export type { ThemePreference } from "../shared/preferences.js";

export const themeStorageKey = "rvw.theme";

export function parseThemePreference(value: string | null): ThemePreference {
  return isThemePreference(value) ? value : "system";
}

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(themeStorageKey));
  } catch (error) {
    console.warn("テーマ設定を読み込めませんでした。システム設定を使用します。", error);
    return "system";
  }
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch (error) {
    console.warn("テーマ設定を保存できませんでした。", error);
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference;
}

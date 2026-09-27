import { create } from "zustand";

/** Day = light UI + daylight twin; night = dark UI + night twin (the default). Remembered in a cookie. */
export type Theme = "day" | "night";

export const THEME_COOKIE = "crt-theme";

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme === "day" ? "light" : "dark";
  // read by the root layout on the next request, so the server renders this theme straight away
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Adopt the theme the server rendered (call once on mount). */
  sync: () => void;
}

export const useThemeStore = create<ThemeState>()((set) => ({
  theme: "night",
  setTheme: (theme) => {
    apply(theme);
    set({ theme });
  },
  sync: () => set({ theme: document.documentElement.dataset.theme === "light" ? "day" : "night" }),
}));

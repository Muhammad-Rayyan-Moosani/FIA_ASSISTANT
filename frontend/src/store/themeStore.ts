import { create } from "zustand";

/** Day = light UI + daylight twin; night = dark UI + night twin. Remembered per browser. */
export type Theme = "day" | "night";

const KEY = "crt-theme";

/** Runs before first paint (inlined in the root layout) so the page never flashes the wrong theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t!=="day"&&t!=="night")t=matchMedia("(prefers-color-scheme: light)").matches?"day":"night";document.documentElement.dataset.theme=t==="day"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}})()`;

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme === "day" ? "light" : "dark";
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Adopt the theme the boot script picked (call once on mount). */
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

export type Theme = "light" | "dark" | "oled";
export const THEMES: { id: Theme; label: string }[] = [
  { id: "dark", label: "Relay Dark" },
  { id: "oled", label: "Relay OLED Black" },
  { id: "light", label: "Relay Light" },
];
const KEY = "relay.theme";

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "oled") return saved;
  } catch {}
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {}
}

/** Inline before paint so the first frame already has the right theme. */
export const themeBootScript = `try{var t=localStorage.getItem("${KEY}");if(t!=="light"&&t!=="dark"&&t!=="oled")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`;

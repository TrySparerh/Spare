import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initI18n } from "./i18n";
import { installDomTranslateGuard } from "./lib/domTranslateGuard";

// Before React mounts: keeps a browser's own page translator (Chrome / Edge /
// Immersive Translate) from crashing React when it wraps text in <font>.
installDomTranslateGuard();

// Render once the language is ready: English is bundled and settles at once;
// a returning 简体中文 / 繁體中文 visitor waits for that language's chunk, so
// the first frame is already in their language.
void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});

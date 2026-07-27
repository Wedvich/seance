import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./base.css";
import { App } from "./app.tsx";
import { watchSystemTheme } from "./theme.ts";

watchSystemTheme();

// Prompts are the one thing here the user authored, so make eviction unlikely.
void navigator.storage?.persist?.();

const root = document.querySelector("#root");
if (root === null) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

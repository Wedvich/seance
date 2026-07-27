import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const DEV_RELAY_URL = "ws://127.0.0.1:8787/app";

/** Origin only — CSP matches host, not path. */
function relayOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Emits dist/_headers (read by Workers static assets). Generated rather than
 * committed because the CSP has to carry two build-time facts: the sha256 of
 * the inline theme boot script, and the relay origin the app may talk to.
 */
function securityHeaders(outDir: string, relay: string): Plugin {
  return {
    name: "seance:security-headers",
    async closeBundle() {
      const htmlPath = join(outDir, "index.html");
      const html = await readFile(htmlPath, "utf8");
      const inline = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/u.exec(html)?.[1];
      if (inline === undefined) {
        throw new Error("no inline script in the built index.html — the theme boot script is missing");
      }
      const hash = createHash("sha256").update(inline, "utf8").digest("base64");
      const csp = [
        "default-src 'self'",
        `script-src 'self' 'sha256-${hash}'`,
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self' ${relayOrigin(relay)}`,
        "worker-src 'self'",
        "manifest-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
      ].join("; ");
      const headers = [
        "/*",
        `  Content-Security-Policy: ${csp}`,
        "  Referrer-Policy: no-referrer",
        "  X-Content-Type-Options: nosniff",
        "  X-Robots-Tag: noindex",
        "  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
        "",
      ].join("\n");
      await writeFile(join(outDir, "_headers"), headers, "utf8");
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  const relay = env["VITE_RELAY_URL"] ?? (mode === "production" ? null : DEV_RELAY_URL);
  if (relay === null) {
    throw new Error(
      "VITE_RELAY_URL must be set for a production build — it pins the CSP connect-src to your relay origin",
    );
  }
  const outDir = join(import.meta.dirname, "dist");

  return {
    // VITE_RELAY_URL reaches the app through import.meta.env; it is read here only
    // so the CSP can name the one origin the app is allowed to connect to.
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        // An external registration script keeps the CSP free of a second inline hash.
        injectRegister: "script-defer",
        manifest: {
          name: "Séance",
          short_name: "Séance",
          description: "Start Claude Code sessions on your own machines",
          start_url: "/",
          display: "standalone",
          orientation: "portrait",
          // Single-valued, so it drives Android's launch splash in one theme only.
          // Dark, because that is the theme this is built and used in.
          background_color: "#121017",
          theme_color: "#19161f",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          // Precaching the shell is the whole point: launching offline must reach
          // the app's own "relay unreachable" state, not the browser error page.
          globPatterns: ["**/*.{js,css,html,woff2,png,txt}"],
          globIgnores: ["**/_headers"],
        },
      }),
      securityHeaders(outDir, relay),
    ],
    build: { outDir },
  };
});

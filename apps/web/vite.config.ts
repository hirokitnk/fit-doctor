import { fileURLToPath } from 'node:url';
import { type Plugin, defineConfig } from 'vite';

/**
 * Content Security Policy for the built site. `connect-src 'none'` makes the browser itself block
 * fetch/XHR/WebSocket/beacon requests, so a dropped file cannot be sent anywhere even by mistake.
 * Applied to production builds only: the dev server needs a WebSocket for hot reload.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'fit-doctor-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  // Relative base so the site works from any GitHub Pages sub-path.
  base: './',
  plugins: [contentSecurityPolicy()],
  resolve: {
    alias: { '@fit-doctor/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) },
  },
  build: { target: 'es2022' },
});

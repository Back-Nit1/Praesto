/**
 * WXT build configuration.
 * ---------------------------------------------------------------------------
 * WXT is the build framework for this Manifest V3 extension. It owns:
 *   - manifest.json generation (from the `manifest` block below + entrypoints),
 *   - bundling each extension context (service worker / content script / UI pages)
 *     with the correct output format,
 *   - dev-mode hot reload.
 *
 * WHY WXT AND NOT A HAND-ROLLED VITE SETUP
 * MV3 has four separate bundle targets with incompatible constraints (the
 * service worker cannot use DOM globals, the content script must be an IIFE
 * that cannot collide with the host page, the UI pages are normal SPAs). WXT
 * encodes those constraints so we do not re-derive them and get them subtly
 * wrong. Every rule in the build stays declarative and reviewable in this file.
 */
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * Build the `connect-src` directive, including the backend origin when one is
 * compiled in.
 *
 * READ FROM THE SAME VARIABLE `backend/config.ts` READS, deliberately. Writing
 * the host in two places is how a manifest and a gateway come to disagree about
 * which single host this extension may reach - and the failure is silent in the
 * direction that matters, because the code would happily request a host the
 * browser then blocks with no message a user could act on.
 *
 * Validation is `backend/config.ts`'s job and is not duplicated here: this runs
 * at build time in Node, where a bad value should fail the build loudly rather
 * than be quietly dropped. An ABSENT value yields a CSP with no backend at all,
 * so a half-configured build makes no requests rather than unenforced ones.
 */
function connectSrc(sources: readonly string[]): string {
  const origin = process.env.WXT_BACKEND_ORIGIN?.trim();
  const all = origin !== undefined && origin.length > 0 ? [...sources, origin] : sources;
  return `connect-src ${all.join(' ')}`;
}

export default defineConfig({
  // Source lives under src/ so the repo root stays readable (docs, fixtures,
  // config) and the bundler has a single unambiguous root to watch.
  srcDir: 'src',

  /**
   * Build into `dist/`, not WXT's default `.output/`.
   *
   * The leading dot makes a directory hidden on macOS and Linux, and Chrome's
   * "Load unpacked" file picker hides it too - so the very first thing a user
   * has to do with this project is discover Cmd+Shift+period. A visible folder
   * removes that entirely.
   */
  outDir: 'dist',

  /**
   * Static files copied to the build root verbatim (the icons).
   *
   * Set explicitly because WXT resolves `publicDir` against the PROJECT root,
   * not against `srcDir` - so the default would be `./public` while everything
   * else in this project lives under `src/`. Pointing it at `src/public` keeps
   * all source in one place.
   */
  publicDir: 'src/public',

  modules: ['@wxt-dev/module-react'],

  /**
   * The manifest is a FUNCTION of the build environment.
   *
   * SECURITY: only so that the CSP can be strict in production and still allow
   * WXT's hot-reload websocket in development. Everything else is identical
   * between the two, and the relaxation below is unreachable in a shipped
   * build - see `connect-src` in `content_security_policy`.
   */
  manifest: ({ mode }) => ({
    name: 'Personal Job Application Agent',
    description:
      'Fills job applications from your own verified profile. Leaves anything it is not sure about blank.',
    version: '0.1.0',

    /**
     * PERMISSION MINIMALISM
     * Every permission here is a promise to the user and a Chrome Web Store
     * review risk. We request only what the architecture actually needs:
     *
     *  storage    - chrome.storage.local for profile metadata + settings.
     *  sidePanel  - the review/audit surface described in spec section 22.
     *  scripting  - lets the service worker inject the scanner on demand rather
     *               than force-running a content script on every page load.
     *  activeTab  - grants temporary host access to the tab the user clicked the
     *               extension on. This is the key privacy lever: it means we do
     *               NOT need `<all_urls>` host permissions at install time.
     *
     * NOT requested (deliberately): host_permissions for <all_urls>, tabs,
     * webRequest, cookies, history. Any future ATS-specific host permission
     * should be added as an OPTIONAL permission the user grants per site.
     */
    permissions: ['storage', 'sidePanel', 'scripting', 'activeTab'],

    /**
     * Optional host permissions: requested at runtime, per origin, only when the
     * user asks the extension to work on a site. Chrome shows a native prompt.
     * This keeps the install-time permission warning as small as possible, which
     * materially affects install conversion for a public extension.
     *
     * BOTH SCHEMES ARE DECLARED, and they have to be. A permission request for
     * a pattern outside this list is refused by Chrome outright, and the panel
     * treats http(s) alike when it classifies a page - so declaring only
     * `https` meant an http page was judged scannable, offered the user a
     * "grant access" button, and then had the grant rejected with no
     * explanation. http matters in practice for the local fixture server this
     * project ships and for intranet-hosted ATS instances.
     */
    optional_host_permissions: ['https://*/*', 'http://*/*'],

    /**
     * Icons. Generated by `scripts/generate-icons.py` from src/public/icon/.
     *
     * All four sizes are provided rather than relying on Chrome to downscale
     * one: 16 is the toolbar (the size users see constantly), 32 is Windows,
     * 48 is the extensions page, 128 is the Web Store listing and the install
     * dialog. Letting Chrome resample 128 down to 16 produces a blurry toolbar
     * icon, which is the one that has to stay recognisable.
     */
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },

    action: {
      default_title: 'Personal Job Application Agent',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },


    // Opening the side panel from the toolbar icon is handled in background.ts.
    // It uses action.onClicked + sidePanel.open so that the click both restores
    // activeTab and becomes the panel's scan request.
    side_panel: { default_path: 'sidepanel.html' },

    /**
     * CONTENT SECURITY POLICY - see Security.md section 3.
     *
     * Was `script-src 'self'; object-src 'self';`. The additions are the ones
     * that matter for an extension holding a person's identity documents:
     *
     *  connect-src   THE EXFILTRATION CONTROL, and the reason this block is
     *                worth the lines. Today the extension makes no network
     *                request at all, so `'self'` costs nothing - and it means
     *                that a bug, a compromised dependency, or an injected
     *                script CANNOT POST the profile or the resume to an
     *                attacker's host. The browser refuses the connection.
     *
     *                Now that the semantic fallback makes real requests, OUR
     *                BACKEND ORIGIN is added - and nothing else. Note where it
     *                comes from: the SAME build variable `backend/config.ts`
     *                compiles into the gateway. That is the point of reading it
     *                here rather than writing the host twice. The manifest and
     *                the code cannot disagree about the one host this extension
     *                may reach, and a build with no origin configured gets a
     *                CSP of `'self'` - so a half-configured build makes no
     *                requests rather than unenforced ones.
     *
     *                This is the second of two independent controls. The first
     *                is ours and could be defeated by a bug in our code; this
     *                one is the browser's and cannot. Do not add a model
     *                provider's origin: calling one directly means the API key
     *                is in the client, which Security.md section 2 rules out.
     *
     *  frame-ancestors 'none'  nothing may embed our pages. Chrome already
     *                blocks this for non-web-accessible resources, so this is
     *                belt-and-braces that also survives a future accidental
     *                `web_accessible_resources` entry.
     *
     *  base-uri 'none'   a <base> tag cannot be injected to re-point every
     *                relative script/stylesheet URL on the page.
     *
     *  form-action 'none'  no page of ours can POST anywhere. We have no
     *                forms that submit; saying so makes it enforced.
     *
     * `script-src 'self'` (no `unsafe-eval`, no remote host) is unchanged and
     * is what keeps PDF.js on its non-eval code path - see
     * resume-parser/pdf/extract.ts, which now asks for that explicitly rather
     * than relying on the exception being caught.
     *
     * DEV ONLY: WXT's hot reload uses a websocket to localhost, which
     * `connect-src 'self'` would block, so `npm run dev` would appear to hang.
     * The relaxation is keyed on `mode` and cannot reach a production build.
     */
    content_security_policy: {
      extension_pages: [
        "script-src 'self'",
        "object-src 'self'",
        mode === 'production'
          ? connectSrc(["'self'"])
          : connectSrc(["'self'", 'ws://localhost:*', 'http://localhost:*']),
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  }),

  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Extension bundles ship to the user's disk and are parsed on every
      // service-worker wake-up. Smaller output = faster cold start on low-end
      // machines. Source maps only in dev.
      sourcemap: process.env.NODE_ENV !== 'production',
      target: 'chrome110',
    },
  }),
});

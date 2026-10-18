# Token Sync

Change design token values and watch any website update in real time. A Brad Frost Web lab.

```
Source ──▶ Room ──▶ Applier
```

A **source** (a control panel, a CLI watching your token files, Eddie's theme customizer) sends token changes to a **room**. Every **applier** in the room (a page with the drop-in script, a bookmarklet, the extension) sets those values as CSS custom properties on the open page. It works with any design system that uses custom properties. Eddie's theme contract is an optional adapter that adds typed, contrast-safe controls.

**Preview only.** An applier changes the custom properties of the tab it runs in, and nothing else. Real visitors never join a room, so nothing changes in production.

![The demo target page after a sync: blue primary buttons, rounded cards, and a pale blue page background, with the status line "Applied 3 token changes 2 ms after it was sent."](docs/demo-target.jpg)

## Try it

```bash
npm install
npm start
```

1. Open <http://127.0.0.1:4321/>, the source page.
2. Select **Open the target page**. It opens with `?token-sync=demo`.
3. Change a colour or the corner radius on the source. The target follows within milliseconds, with no network: both tabs talk over `BroadcastChannel`.

[TESTING.md](TESTING.md) walks through every way to try it: Eddie's customizer, a phone on your wifi (`HOST=0.0.0.0 npm start`), your own token files, the bookmarklet and the extension.

The demo pages load Eddie from unpkg, so they need a network connection to render. Syncing itself doesn't.

## Add it to a page

```html
<script type="module" src="/path/to/packages/script/src/token-sync.js"></script>
```

While a tab is in a room, hold <kbd>\</kbd> to see the page as it was before the room touched it, and let go to see it again. Each way, the new look sweeps in from the inline-start edge with a View Transition (300 ms). To sweep every live change in as well, as you might on a stage display, add `<meta name="token-sync-wipe" content="changes">`. Under `prefers-reduced-motion` nothing sweeps; changes land instantly. The sweep never cancels a view transition the page is running, and clicks pass through it.

The script does nothing on an ordinary page view. Visit the page with `?token-sync=<room>` and that tab joins the room, then stays in it for the rest of the tab's session as you click around. `?token-sync=off` leaves.

### Or as one file

`npm run build` writes `dist/token-sync.js`: the same drop-in as a single classic script, with no module graph to serve. Load it with `<script src="token-sync.js"></script>`, and it exposes `window.TokenSync` (`start`, `resolveRoom`, `PARAM`, `STORAGE_KEY`).

## The bookmarklet

To preview a site you can't add a script to, run `npm start` and open <http://127.0.0.1:4321/demo/bookmarklet.html>. Drag the link to your bookmarks bar, select it on any page, and type a room code. Type `off` to leave. A bare room code reaches only other tabs on that same site; type `room@relay-url` (`detach@http://127.0.0.1:8787`) to join a room on a relay, which is how a source on another site, a phone or the CLI reaches it. You type the relay yourself, so a link can't choose it. Chrome asks once per site before a public page may reach a relay on your own machine (Local Network Access). It only reaches the page you select it on, and a strict Content Security Policy can block it. `npm run build` also writes the URL to `dist/bookmarklet.txt`.

Both files come from `tools/bundle.js`, a small bundler written for this repo's own module style, so the build adds no dependency (see Deviations). It refuses anything it doesn't translate (default exports, namespace imports, `export let`, multiple declarators, dynamic `import()`, non-relative imports, cycles, and an import of a name its module doesn't export) rather than guessing.

## The browser extension

For sites you can't add a script to and where a bookmarklet is blocked, there's an MV3 extension for Chromium and Firefox:

```bash
npm run build:extension   # writes dist/extension/
```

Load `dist/extension/` unpacked: `chrome://extensions` → Developer mode → **Load unpacked**. Open the popup on the tab you want, enter a room code and relay, and choose **Preview this tab in the room**.

**Tested in Chrome. Built for Firefox, but not yet tried there.** The manifest carries what Firefox 128+ needs (`background.scripts`, a gecko id), and the popup asks for permission the way Firefox requires. To try it: `about:debugging` → This Firefox → **Load Temporary Add-on** → `dist/extension/manifest.json`.

- **Rooms live on a relay.** The extension joins rooms on a relay, so the room can hold phones and other machines. A room that lives inside the extension and spans tabs on different sites with no network (FEATURE-SPEC Flow B) is #20.
- **One tab at a time.** Previewing another tab stops the first, and its page goes back to how it was.
- **Only sites you allow.** The first preview on a site asks the browser for permission for that one site (no blanket "all sites" grant). The site joins the room's allowed list, and as the tab moves between allowed sites the room comes back on every page. The popup lists the allowed sites, and removing one also gives back its permission.
- **The background holds the relay connection**, so a page's Content Security Policy can't block it. The synced page sends a heartbeat that keeps the background awake. If the browser stops the background anyway, the page reconnects, and the restarted background replays the room. The page runs only the applier, with the same guardrails as the drop-in, including hold <kbd>\</kbd> to compare.
- **On Eddie pages it brings Eddie's contract**, as the Eddie drop-in does: `contract:` knobs expand and stay legible, and what was nudged shows in the page's own `ed-toast` when the page defines one (the content script runs in an isolated world and can't register components; otherwise it goes to the console). The content script carries the adapter, about 118 KB, on every allowed site.
- **The popup is built from Eddie**, bundled in from the pinned packages, because MV3 forbids remote code.

`npm run extension:smoke` loads the built extension into real Chrome over the DevTools protocol. It checks that the extension loads, its service worker starts, and the popup renders Eddie.

## Rooms across machines: the relay

`BroadcastChannel` only reaches tabs in one browser. To put phones, a second laptop or a stage display in the same room, run a relay:

```bash
npm run relay           # the Node relay on http://127.0.0.1:8787, no dependencies
```

Then open the source page with `?relay=http://127.0.0.1:8787`. It creates a room, holds the room's **presenter key**, and links the target page to that room.

A site follows a relay by declaring it in its own markup, next to the drop-in:

```html
<meta name="token-sync-relay" content="https://relay.example" />
```

The relay URL never comes from the address bar, so a crafted link can't point a visitor's tab at someone else's relay. A link can still put a visitor's tab in any room on *your* relay, and the guardrails are what keep that harmless. Without the meta tag, the drop-in stays on `BroadcastChannel`, and an invalid one is ignored with a console warning.

| Endpoint | Does |
|---|---|
| `POST /rooms` | Creates a room. Returns `{ room, presenterKey }`. Send `{ "room": "detach" }` to choose the code. |
| `GET /rooms/<room>` | 200 if the room exists, 404 if not |
| `GET /rooms/<room>/socket` | WebSocket. Send `{ kind: 'hello', key? }`, then `{ kind: 'msg', msg }`. The relay answers with `welcome`, `msg` and `error` frames. |

The relay is where the rules are enforced for real:

- It stamps every `ts` and discards whatever a client sent.
- Only the connection that said hello with the presenter key may reset, lock, unlock or speak as `presenter`.
- A lock refuses every write that doesn't come from the presenter, whatever role it claims.
- Each connection may send at most 20 messages a second.
- A joiner gets the room's writes again as sets, at each write's real time, then the lock state. An empty `snapshot` from a client asks for the same catch-up.

### Two relays, one room core

- **Node** (`packages/relay/node/server.js`): no dependencies, including its WebSocket server, so anyone can self-host. Rooms live in memory.
- **Cloudflare** (`packages/relay/worker/`): a Worker routing to one Durable Object per room. The presenter key and the room's state live in the object's storage, so they survive eviction. Sockets use the hibernation API. A room is deleted a day after its last connection closes.

Both wrap `packages/relay/src/room.js`, so self-hosting changes nothing about the guarantees. The same protocol tests run against either: `npm test` runs them against the Node relay, and `npm run relay:worker` then `npm run relay:worker:test` runs them against the Durable Object under `wrangler dev`.

The demo's latency readout subtracts the relay's timestamp from the viewer's clock. On one machine that's a true delivery time. Across machines it includes clock skew, so the spec's "p95 under 300 ms over the hosted relay" can't be measured until the relay is deployed and measured from one clock.

**The Cloudflare relay has not been deployed.** That's Brad's call: `npm exec --no -w packages/relay -- wrangler deploy` once approved.

## The phone remote

With a relay running, open the source page with `?relay=…`. It creates a room and shows a **phone remote** link to share with the audience: `packages/remote/index.html?room=<code>&relay=<url>`.

The remote is an Eddie page that joins the room as a controller. Anyone holding it can change the button colour, the page background and the corner roundness on the big screen; the last change wins.

- **Coalesced sends.** However fast someone drags a slider, the remote sends at most 10 messages a second (FEATURE-SPEC §8, `createCoalescer` in `client`).
- **Status the controls can explain.** A polite live region says when it's joining, connected, reconnecting, unable to reach the room, paused, or reset. When the presenter locks the room, the controls are disabled and the remote says why.
- **Controls show the room as it stands.** A remote that joins late, or hears a reset, moves its controls to the room's current values.
- **Deferred:** a QR code and a short URL for the room (#18). For now the presenter shares the link.
- **One known gap:** Eddie's colour swatches and slider thumb are smaller than the spec's 44 px phone target. They meet WCAG 2.5.8's 24 px. That's filed upstream (#16, Brad-Frost-Web/eddie-design-system#2457) rather than patched over with custom CSS.

Eddie's theme customizer can drive a room too (eddie-design-system#2447). It isn't in an Eddie release yet: `npm run eddie:develop` builds Eddie's develop branch locally, and <http://127.0.0.1:4321/demo/customizer.html> hosts it as a controller. See [TESTING.md](TESTING.md).
## From your token files: the CLI

```bash
npm run token-sync -- relay                                # a local relay, if you don't have one
npm run token-sync -- watch dist/tokens.css                # send what changes in a built stylesheet
npm run token-sync -- watch dist/tokens.css --build "npm run tokens" --src tokens/
npm run token-sync -- poll https://codepen.io/<user>/pen/<id>.css   # follow a stylesheet you can't build
```

Run these from this repo, or call `node packages/cli/bin/token-sync.js` directly. Publishing it as an installable `token-sync` command is a later, separate decision.

- **`watch`** reads the custom properties in a built stylesheet. On every save it sends only the ones that changed. With `--build` and `--src` (comma-separate several folders), saving a source file runs your own build first, whether that's Style Dictionary or anything else that writes the stylesheet. Token Sync doesn't depend on Style Dictionary. Builds never overlap, and changes in build output (`build/`, `dist/`, the stylesheet's own folder when it sits inside the source) never start one. So Eddie's theme folders, where the sources and `build/` live side by side, can't loop. For Eddie, from this repo with Eddie checked out beside it: `npm run token-sync -- watch ../eddie-design-system/packages/eddie-design-tokens/bfw/build/css/tokens.css --build "npm --prefix ../eddie-design-system run eddie-design-tokens:build:tokens" --src ../eddie-design-system/packages/eddie-design-tokens/bfw`.
- **`poll`** does the same for a stylesheet at a URL, every `--interval` milliseconds (2000 by default): a CodePen, or a deploy preview (`--header "Authorization: …"` for a protected one). One fetch runs at a time.
- Both talk to a relay (`--relay`, default `http://127.0.0.1:8787`). Without `--room` they create one and print its code and presenter key; open the target page in that room.
- Only properties a stylesheet always defines are sent: anything inside `@media`, `@supports` or `@container` is left out, because one value goes to every page. `!important` is read as the declaration's priority, not part of the value.
- `--selector ":root"` keeps only blocks whose selector list includes that selector, for a stylesheet that defines several themes.
- `--scope southleft` sends the edits for that theme only, so pages wearing another theme ignore them. Pair it with `--selector ".southleft"` when one stylesheet defines several themes. Without it, edits are for every theme. (The phone remote and the demo source always send for every theme.)
- Changes are split into messages the relay accepts, by count and by size, so a full Eddie theme (612 properties) goes through.
- `--send-initial` sends every property once at start.
- A value the protocol refuses is not sent, and the CLI says why. A property that disappears from the stylesheet is cleared on every page (sent as `null`).

## The protocol: `token-sync/1`

One JSON message per change. Eddie's `docs/TOKEN-SYNC.md` is the canonical description, from [eddie-design-system#2447](https://github.com/Brad-Frost-Web/eddie-design-system/pull/2447):

```js
{ v: 1, room: 'detach', op: 'set', props: { '--ed-theme-border-radius-md': '1rem' }, scope: '*', from: 'controller', ts: 1760700000000 }
```

| Field | Meaning |
|---|---|
| `op` | `set`, `reset`, `lock`, `unlock` or `snapshot`. Only a presenter may `reset`, `lock` or `unlock`. A `snapshot` with empty `props` asks the room for its state. One with props answers, and only fills tokens the receiver doesn't already show, for its theme or every theme. |
| `props` | Custom property names, or `contract:` keys: `contract:color.background.brand` is a contract path, and `contract:color.background-brand` is a lab knob that re-derives what hangs off it. `null` clears a token. |
| `scope` | A theme id or `*`. An edit for a theme shows only on a page wearing it (`<html class="bfw">`), as on Eddie's displays; absent or `*` means every theme. Pages keep every theme's edits, so they can answer a joiner wearing any theme, and switching theme mid-session shows that theme's edits at once. A page with no theme class shows only unscoped edits. |
| `fonts` | Up to 8 family names the props use. Validated; the lab loads fonts from the `font-family` values it applies, which name the same families. |
| `from` | A role: `controller`, `presenter` or `source`. Never an identity. |
| `ts` | Stamped by the channel (the relay, or the local channel), never the sender. Each key keeps its last write by `ts`. |

### With Eddie's theme customizer

An `ed-r-theme-customizer` and a lab page in the same browser share a room with nothing else running. The customizer needs `transport="broadcast"` and the same `room`. Both use the channel `token-sync:<room>` and post plain messages, so either side can be the source or the display.

- When a page joins, it posts an empty snapshot to ask for the room's state. Lab pages answer with their writes grouped by when they happened. A customizer answers with what it has published.
- A broadcast answer leaves out the last reset. An Eddie display clears everything it has written when any reset arrives, however old, so replaying one would wipe newer writes on every Eddie page in the room.
- On the relay, a customizer takes the lab's remote transport as its `remoteTransport`.
- Two writes stamped in the same millisecond can settle differently on lab and Eddie pages. The lab picks the larger value; Eddie keeps whichever arrived last.
- A stamp more than 5 seconds in the future is dropped on broadcast; Eddie pulls one more than a minute ahead back to now. Both share one machine's clock, so an honest message is never near either limit.

### Fonts

Set a `font-family` token to a family the page doesn't have, and the applier fetches it from Google Fonts for the preview: `--ed-theme-typography-headline-lg-font-family: "Fraunces", serif`.

- A family the page already has, from its own `@font-face` rules, is never requested.
- Family names may only hold letters, digits and spaces.
- The request URL is built with the URL API.
- Nothing is fetched outside a session, and the links come out when the tab leaves the room.

### Guardrails

- **Values are checked before they land.** Refused anywhere in a value: `url(`, `;`, `{`, `}`, `!important`, backslashes (a CSS escape can spell `url(` without the letters), `<`, `>`, `@`, and anything outside printable ASCII. Only colour functions, `calc`/`clamp`/`min`/`max`, the easings `cubic-bezier`/`steps` and `var()` may appear, so nothing that fetches can get in. A refused value is dropped on its own, as Eddie does, and the rest of the message still lands. A message with something wrong outside its props, such as its op, room, role or stamp, is refused whole. Then each value must parse as the kind of value the property already holds on the page: a colour stays a colour, a length stays a length.
- **`setProperty` only.** Values are never joined into CSS text, so a value can't become a rule.
- **Damping.** A page changes at most 3 times a second, whatever arrives (WCAG 2.3.1). The first change lands immediately. Changes arriving faster than that are combined, and the latest one lands at the end of each 333 ms window. So a lone edit lands in a few milliseconds, and an edit inside a burst can wait up to a third of a second.
- **Reset and lock.** A presenter can put every page back to its theme, or make controllers read-only. Over `broadcast` every tab is a presenter. Over the relay, only the holder of the room's presenter key is.
- **Last write wins per token**, ordered by the channel's timestamps. Ties resolve the same way on every peer, so every tab ends up showing the same state.

### On Eddie pages: contract knobs, kept legible

In Eddie's `bfw` build, component tokens hold literal values rather than `var()` references. A raw override only moves the exact token sent: overriding `--ed-theme-color-background-brand` doesn't recolour a primary button.

On an Eddie site, use the Eddie drop-in, `packages/script/src/token-sync-eddie.js` (`dist/token-sync-eddie.js` once built), instead of `token-sync.js`. It brings Eddie's theme contract (`packages/adapter-eddie`, built on `@brad-frost-web/eddie-design-tokens/contract`). The plain drop-in leaves it out, because the contract adds about 70 KB that a site not built on Eddie has no use for. The adapter switches on once the page shows Eddie's tokens, including a page whose stylesheet arrives after the script.

- **Knobs.** `contract:color.background-brand` is one value that Eddie expands into every token derived from it: buttons, links, text on brand. Only what a knob actually changes is written; an accent knob touches its accent and the text on it, nothing else. Colour and button knobs are supported (`contract:color.<knob>`, `contract:buttons.<knob>`). Border, shadow, motion and gradient knobs are [#22](https://github.com/Brad-Frost-Web/token-sync/issues/22).
- **Legibility.** When a knob, or a raw colour that lands on a contract path, changes a colour, the contract's solver checks every foreground/background pair against WCAG AA. It uses the theme's own button type scale, so buttons get the large-text floor only where the theme earns it. It may move any *text* colour, including a raw one, to keep it legible. It keeps authored backgrounds where they are.
- **Said out loud.** What the solver moved shows on the page briefly, in one `ed-toast` ("Nudged content brand 36% darker to stay readable."). What it couldn't fix, or couldn't check (a colour that isn't hex), stays on screen until it clears. Raw values outside the contract are applied as sent, and the page says how many colours among them went unchecked. Everything also goes to the console, which is all a page without `ed-toast` gets.

The bookmarklet leaves the adapter out to keep its URL short.

## Packages

| Package | Job | Status |
|---|---|---|
| `protocol` | `token-sync/1` validation, value checks, per-key last-write-wins | Built |
| `client` | Transports (`local`, `broadcast`, `remote`) and the applier | Built |
| `script` | The `?token-sync=<room>` drop-in | Built |
| `relay` | Cloudflare Durable Object per room, and a self-hostable Node relay | Built, not deployed |
| `bookmarklet` | One-click applier for any page, plus the single-file build | Built |
| `extension` | MV3 applier, Chromium and Firefox | Built, not published |
| `cli` | `token-sync watch`, `poll` and `relay` | Built |
| `remote` | The phone remote | Built (interim, until Eddie #2447) |

Also built: the before/after wipe and hold-to-compare key (`packages/client/src/wipe.js`), and Google Fonts sync (`packages/client/src/fonts.js`).

The packages are plain ES modules with no runtime dependencies. They import each other by relative path, so a browser can load them straight from disk, and `npm run build` makes the single-file versions.

## Tests

```bash
npm test
```

Node's built-in test runner. The suites cover the bundler and the built bookmarklet (run end to end in a sandbox), the value refusals, message validation, last-write-wins ordering and convergence, snapshots for late joiners, damping (with fake timers), and the broadcast transport over a real `BroadcastChannel`.

## Deviations from the BFW defaults

Documented per AGENTS.md §1.6:

- **The Node relay is about 400 lines, not 50.** Issue #2 pictured a ~50-line relay on a WebSocket library. Writing the WebSocket server by hand keeps it dependency-free, and moving the rules into a shared core (`src/room.js`) means self-hosting can't weaken them.
- **Cloudflare, not Netlify, for the relay.** Netlify functions can't hold WebSockets. Cloudflare is already a BFW vendor (bf-brain), and FEATURE-SPEC §7 settles it. `wrangler` is the relay package's only dependency, and it's a dev dependency.
- **Vanilla JS with no framework, no build and no Eddie runtime dependency** in the packages. They run inside other people's pages, so they carry nothing those pages didn't ask for. The lab's own UI (the demo pages here, and later the remote and the extension popup) is built from Eddie.
- **The contract is imported by relative path into `node_modules`** (`../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/…`). The same file then runs unbundled in a browser, in Node, and through the bundler. The demo server serves that one folder.
- **Our own bundler instead of a third-party one.** `tools/bundle.js` covers the handful of import/export forms these packages use and refuses the rest, which kept the build free of dependencies. If the packages ever need syntax it refuses, adopting esbuild (pinned) is the move, not stretching the bundler.
- **Google Fonts.** AGENTS.md §2.2 forbids Google Fonts links. Token Sync's font sync requests from `fonts.googleapis.com` (which serves files from `fonts.gstatic.com`), but only while a tab is in a room, and the links are removed when it leaves. Brad decided this in FEATURE-SPEC §10 Q3. It's preview-only by construction, and nobody should copy the pattern into a shipping product.

## Process

Built under [bfw-process](https://github.com/Brad-Frost-Web/bfw-process) in Quick mode (`projectType: experiment`, trunk branch model). The Eddie side of Token Sync, where `ed-r-theme-customizer` becomes a source and a controller, lives in [eddie-design-system#2447](https://github.com/Brad-Frost-Web/eddie-design-system/pull/2447). Origin: [eddie-design-system#1535](https://github.com/Brad-Frost-Web/eddie-design-system/issues/1535).

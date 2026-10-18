# Testing Token Sync locally

Everything here runs on your Mac. The relay is the local Node one, so nothing is deployed and nothing reaches a real site's visitors. Each test stands alone; start with 1.

```bash
cd ~/Sites/token-sync
git pull
npm install
```

## 1. Two tabs, no network (2 minutes)

```bash
npm start
```

1. Open <http://127.0.0.1:4321/> (the source page).
2. Select **Open the target page**.
3. Change the button colour, page background or corner radius on the source. The target follows, and its status line says how many milliseconds it took.
4. On the target, hold <kbd>\</kbd> to see the page without the room's tokens. Let go to see them again.
5. On the source, **Reset every tab** puts the target back. (Locking a room only means something on a relay, where there are senders to lock out: test 3.)

## 2. Eddie's theme customizer driving a page (10 minutes the first time)

The customizer's room support (eddie-design-system#2447) is on Eddie's `develop` branch but not in a release yet, so the lab builds `develop` for itself:

```bash
npm run eddie:develop     # once; a few minutes. Your Eddie checkout is not touched.
npm start
```

`eddie:develop` looks for Eddie at `../eddie-design-system`. Pass `-- --eddie <path>` if yours lives elsewhere. It exports `origin/develop` with `git archive` and builds it into `.eddie-develop/` here, which git ignores. Run it again to pick up newer Eddie work.

1. Open <http://127.0.0.1:4321/demo/customizer.html>.
2. Select **Open the target page**.
3. In the customizer, open **Theme** and press **Random**, or change any colour, font or slider. The target follows: colours, fonts (loaded from Google Fonts, for the preview only), radii and shadows.
4. Where Eddie's contrast solver can't make some text readable on a new background, the target's toast names up to three tokens. The console has the full list.

## 3. A phone in the room (10 minutes)

A phone can't reach `127.0.0.1`, so open both servers to your local network. Use a trusted network, such as your home wifi; anyone on it can reach these two ports while they run.

```bash
HOST=0.0.0.0 npm start
```

```bash
npm run relay -- --host 0.0.0.0
```

Both print an address like `http://192.168.1.20:…`. If they print more than one, use your Mac's Wi-Fi address (System Settings › Wi-Fi › Details › IP address). Below, `<mac>` is that address.

1. On the Mac, open `http://<mac>:4321/demo/source.html?relay=http://<mac>:8787`. It creates a room on the relay and shows a **phone remote** link.
2. Select **Open the target page** on the Mac.
3. Get the phone remote link to your phone (AirDrop, or copy it into a message to yourself), and open it there.
4. Move the controls on the phone. The target on the Mac follows.
5. On the Mac's source, **Lock the room**: the phone's controls disable and say why. Select **Lock the room** again to unlock.

## 4. Your own token file (5 minutes)

With `npm run relay` (or the LAN relay above) and a target open in a relay room, as in test 3:

```bash
npm run token-sync -- watch path/to/tokens.css --relay http://127.0.0.1:8787 --room <room> --send-initial
```

`<room>` is the code the source page shows. Edit and save the stylesheet: changed custom properties go to the room. Delete one and it clears on the page. For a stylesheet that defines several themes, add `--selector ".southleft" --scope southleft`. Against Eddie's own tokens:

```bash
npm run token-sync -- watch ../eddie-design-system/packages/eddie-design-tokens/bfw/build/css/tokens.css --relay http://127.0.0.1:8787 --room <room>
```

## 5. Any website: the bookmarklet (5 minutes)

A bookmarklet on another site can't hear the demo pages over BroadcastChannel (browsers keep that per site), so it joins through the relay.

1. Run `npm start` and `npm run relay`, and open <http://127.0.0.1:4321/demo/source.html?relay=http://127.0.0.1:8787>. Note the room code it shows.
2. Open <http://127.0.0.1:4321/demo/bookmarklet.html> and drag the link to your bookmarks bar.
3. On any site, select the bookmark and type `<room>@http://127.0.0.1:8787`.
4. **Chrome asks to let the site reach apps and services on this device** (that's the local relay). Choose **Allow**. If you dismiss it, the page can't join; allow it from the site settings (the icon left of the address bar) and run the bookmark again.
5. Change tokens on the source page. Only custom properties the site really uses change anything. Eddie-powered sites like bradfrost.com change the most.
6. Select the bookmark again and type `off` to leave.

## 6. Any website: the extension (5 minutes)

```bash
npm run build:extension
npm run relay
```

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and pick `dist/extension/`. (Reload it there after rebuilding.)
2. Open a site, open the extension's popup, and enter a relay room code from test 3 or 4 and the relay (`http://127.0.0.1:8787`).
3. Select **Preview this tab in the room**, and allow the site when Chrome asks.
4. Send changes from the source page (opened with `?relay=http://127.0.0.1:8787`, in the same room), the phone remote or the CLI.

## 7. Theme scope (2 minutes)

The target page wears `bfw`. An edit made for another theme is kept but not shown.

1. In test 2, choose **southleft** in the customizer, then change a colour. The target ignores it, and its console says once that it isn't showing southleft edits.
2. In the target's DevTools console, run `document.documentElement.classList.replace('bfw', 'southleft')`. The southleft edits appear straight away.

## When something looks wrong

- **A real site can't join the local relay.** Chrome's Local Network Access permission: allow "apps and services on this device" for that site.
- **The target doesn't follow.** Check that both tabs show the same room code, and, for relay rooms, that the relay is running. The target's console says why it dropped a message.
- **The customizer page shows build instructions.** Run `npm run eddie:develop`.
- **The phone can't load the page.** macOS may be blocking incoming connections: allow `node` when macOS asks, or in System Settings › Network › Firewall. Check the phone is on the same wifi as the Mac.
- **A port is taken.** `PORT=4322 npm start`, or `npm run relay -- --port 8790`.
- **Stop everything.** <kbd>Ctrl</kbd>+<kbd>C</kbd> in each terminal.

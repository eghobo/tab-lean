# TabLean

TabLean is a Chrome extension that unloads idle tabs inside collapsed tab groups. The tabs and their groups stay in place, but Chrome can release the memory used by pages you are not currently using.

Everything runs locally. TabLean does not have an account system, analytics, advertising, or a server.

## How it works

TabLean starts watching a group when you collapse it. It considers how recently each tab was used and avoids active, audible, or important tabs. Eligible tabs are passed to Chrome's built in discard function. Opening one of those tabs again reloads it normally.

The sensitivity control changes how readily TabLean unloads an idle tab. The Activity page shows successful unloads and keeps a short local history. It does not show an invented memory estimate because Chrome does not provide reliable memory figures for individual discarded tabs.

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on Developer mode.
4. Select Load unpacked.
5. Choose the folder containing `manifest.json`.

TabLean then runs automatically. Collapse a tab group and continue browsing as usual.

## Development

The extension uses plain HTML, CSS, and JavaScript with Manifest V3. It has no runtime dependencies and makes no network requests.

Run the tests with:

```sh
npm test
```

If you change the source, return to `chrome://extensions` and reload TabLean before testing it again.

## Privacy

TabLean stores its settings and Activity history in Chrome's local extension storage. Nothing is sent outside the browser. Read [PRIVACY.md](PRIVACY.md) for the full details.

## License

TabLean is available under the [MIT License](LICENSE).

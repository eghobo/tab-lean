# TabLean

TabLean is a Chrome extension that unloads idle tabs inside collapsed tab groups. The tabs and their groups stay in place, but Chrome can release the memory used by pages you are not currently using.

Everything runs locally. TabLean does not have an account system, analytics, advertising, or a server.

## How it works

TabLean starts watching a group when you collapse it and waits at least 30 seconds before unloading its tabs. It skips active, audible, loading, incognito, already discarded, and explicitly non-discardable tabs. Eligible tabs are passed to Chrome's built in discard function. Opening one of those tabs again reloads it normally.

The sensitivity slider sets the time since a tab was last activated in its window: 5 minutes at Gentle, 30 seconds at Maximum, and 1 minute 24 seconds at the default sensitivity of 80. The popup shows the selected timeout. Chrome may deliver the review later, especially after the computer sleeps. Tab activation counts are not collected.

Use **Never unload these sites** in the popup to keep important sites loaded. Enter one hostname per line, such as `example.com`; the rule also covers its subdomains. Chrome's tab metadata does not reliably expose unsaved work or all background activity, so add editors and meeting sites that must remain loaded. TabLean makes no changes to Chrome's own Memory Saver settings or exclusion list.

The Activity page shows successful unloads and keeps a short local history. It does not show an invented memory estimate because Chrome does not provide reliable memory figures for individual discarded tabs.

### Chrome tab-group sync

TabLean does not move, regroup, close, or recreate tabs. It only asks Chrome to discard eligible page contents from memory, leaving each tab in the same group and position. Chrome remains solely responsible for syncing saved tab groups and their tab order between devices.

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

TabLean stores its settings and Activity history in Chrome's local extension storage. Collapse timestamps use temporary extension session storage so a sleeping service worker can resume safely. Nothing is sent outside the browser. Read [PRIVACY.md](PRIVACY.md) for the full details.

## License

TabLean is available under the [MIT License](LICENSE).

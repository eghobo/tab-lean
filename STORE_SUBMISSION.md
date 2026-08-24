# Chrome Web Store submission notes

This file contains the text needed for TabLean's first Chrome Web Store submission.

## Name

TabLean: Smart Tab Memory Saver

## Summary

Automatically unloads idle tabs in collapsed groups to help Chrome use less memory without closing your tabs.

## Category

Productivity

## Detailed description

TabLean helps Chrome use less memory when you keep many tabs organized in groups.

Collapse a tab group and TabLean watches the tabs inside it. Idle tabs can be unloaded through Chrome's built in discard feature while the tabs and group remain visible. Select an unloaded tab whenever you need it and Chrome reloads the page normally.

You can adjust the sensitivity to control how readily idle tabs are unloaded. Active and audible tabs are protected. Expanded groups are left alone.

The Activity page shows which tabs TabLean successfully unloaded. It reports real actions confirmed by Chrome and does not invent a memory saving estimate.

TabLean works locally with no account, analytics, advertising, remote server, or network requests.

## Single purpose

TabLean reduces Chrome memory use by automatically unloading eligible idle tabs inside tab groups the user has collapsed.

## Permission explanations

### tabs

This permission lets TabLean check whether tabs are active, audible, loading, recently used, or already discarded. It also lets TabLean ask Chrome to discard eligible tabs and show their titles in the local Activity history.

### tabGroups

This permission lets TabLean detect groups the user has collapsed and display the group title in the local Activity history. Expanded groups are not optimized.

### storage

This permission stores the sensitivity, enabled state, successful discard counts, and the 200 most recent Activity events on the user's device.

### alarms

This permission schedules lightweight follow up checks for collapsed groups without keeping a background page running.

## Remote code

Select No. TabLean does not download or execute remote code.

## Data disclosure

Disclose web browsing activity because TabLean handles tab information, including titles and metadata, to provide its memory saving feature and local Activity page. State that this information is processed locally and is not transmitted, sold, or shared.

Review the available dashboard categories carefully and make sure the selections match the current privacy policy. TabLean does not use data for advertising, credit decisions, or any purpose unrelated to its single function.

## Suggested support text

For help or bug reports, open an issue in the TabLean GitHub repository. Please include your Chrome version, TabLean version, and the steps needed to reproduce the problem. Do not include private browsing information.

## Assets still needed

1. At least one screenshot at 1280 by 800 pixels or 640 by 400 pixels.
2. A public privacy policy link, preferably the published `PRIVACY.md` page.
3. The public GitHub repository link for the website and support fields.
4. A clean ZIP generated from the tested release source.

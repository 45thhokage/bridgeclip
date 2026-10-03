# Changelog

What's new in each version of BridgeClip, newest first. You can also read this in the app under **Settings → About → Changelog** or **Help → Changelog**. Downloads for every version are on [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Maintainers: see [Changelog](CONTRIBUTING.md#changelog) in the contributing guide before editing.

## [Unreleased]

## [0.2.0] - 2026-10-02

### Added

- **What to clip** in Create → Clips: describe the moments you want, such as "every time they talk about pricing". Leave it blank to get the strongest moments as before.
- **Show title at the top** in Create → Captions turns off the title card on Automatic clips.
- **Review & edit** workflow: look over clip candidates before exporting. Trim, split and extend cuts, change layouts and camera changes, fix and place captions, then bake one clip or every ready clip with **Bake all**. You can also swap in a higher-quality copy of the source video.
- Jobs show progress for each stage on a timeline, a **Job Breakdown** of where the time went, and **Details** with reviews, the transcript and source research.
- The Library shows how many clips in each run are posted, lets you bookmark runs, and deletes whole runs or single clips.
- Settings → About shows how much disk space your output folder uses.
- YouTube links show a preview in Create.
- Automations have **Submitted** and **Needs attention** sections, drag to reorder, **View in Library**, reviewable title and caption drafts, **Refresh post status** and **Return to queue**.
- **TypeSafe Jev review** and **Research the source before clipping**, both in beta and off by default. Turn them on in Settings. Both use extra OpenRouter credit.
- **Free editor media** removes an editor project's source copy and preview once you're done with it.
- BridgeClip asks whether to save or discard unsaved edits before quitting, and offers **Reload project** when a project was changed elsewhere.
- This changelog, in Settings → About and the Help menu.
- **Settings → Pipeline** gives each stage its own source: transcription on OpenRouter or on this computer, and clip planning on OpenRouter, OpenCode Zen, OpenCode Go, a custom https endpoint or a local server you already run. Every combination works, including local transcription with cloud planning.
- **Settings → Local setup** can point clip planning at Ollama, LM Studio, llama.cpp server or a typed OpenAI-compatible address, with a model picker, a context-window setting and **Test connection**. A transcript that does not fit is refused before any request instead of being truncated.
- First launch is three steps — Transcription, Clip planning, Summary — so the two stages are chosen separately, and every cloud provider key row shows **Test connection** and **Used by**.

### Changed

- Smart framing ignores weak background faces, stays on a speaker who briefly looks away, follows talking heads inside 4:3 video, and analyzes footage faster.
- Screen + webcam clips fill the top panel again.
- Editor previews use much less disk space, and downloaded sources are moved into the project instead of copied.
- **Settings** groups the pipeline stages, the cloud keys and the local setup, and names the stage each key belongs to on its own row.
- Clip planning cost shows as **not reported by provider** when a cloud provider does not return prices, and as **$0** when it runs on this computer.

### Fixed

- Smooth camera movement in the editor works in installed apps.
- **Bake all** keeps going when one clip fails, and says what went wrong.
- Titles with emoji at the length limit no longer break editor projects.
- Automations: submitted and held clips can be removed, posted clips no longer count toward the 500-clip limit, a post deleted in Zernio no longer leaves its clip stuck, slots that come due during an enhancement are kept, and one pending draft no longer blocks the rest of the queue.
- Unattended posts no longer use text from the source video's description, and refuse web addresses or @handles that aren't said in the video.
- Deleting a clip also removes its caption and YouTube text files.
- A missing transcript shows a clear message, and research citations can be selected and copied.
- **Settings → Local setup** keeps the GPU and VRAM you pick after saving.
- OpenCode model lists load before a model is chosen, so the picker shows the provider's models and **Refresh models** works.
- Local clip planning works with `http://[::1]` (IPv6 loopback) and with an address typed without a port, and only `127.0.0.1`, `::1` and `localhost` are accepted for a local server.
- **Test connection** asks for a missing OpenCode key instead of a model you cannot pick yet, and a model id with unsupported characters now says so instead of leaving an unsaved value on screen.
- The setup card's **Finish planning later with OpenRouter** runs the key check, so **Finish** works on the Summary step.
- Create and Summary name the clip-planning provider actually in use instead of always saying OpenRouter.

## [0.1.19] - 2026-09-27

One release for macOS, Windows and Linux.

### Added

- Linux installers for x64: an AppImage and a DEB package.

### Changed

- YouTube downloads that fail for a temporary reason retry automatically with a fresh link.
- Playlists and live or upcoming streams are turned away before downloading. Paste a link to a single, finished video.

### Fixed

- An automation keeps posting the rest of its queue when one clip's details can't be verified.
- Generated post captions that quote the video are accepted when the speaker stutters, and captions can no longer contain web links.
- Hardened how BridgeClip handles captions, file paths, titles, downloads and its bundled Python, so unusual input can't change video processing commands or load unexpected code.

## [0.1.18] - 2026-09-25

### Added

- A signed installer for Windows x64. This version shipped for Windows only and has no other changes from 0.1.17.

## [0.1.17] - 2026-09-25

The first version with downloadable installers, starting with macOS.

### Added

- macOS apps for Apple silicon and Intel, signed with BridgeMind's Developer ID and notarized by Apple.
- Automatic updates. BridgeClip checks shortly after launch and every four hours, downloads in the background, and installs when you choose **Restart to update** or the next time you quit. Settings → About shows the status and has **Check for updates**.
- Clip public, finished Twitch VODs by pasting their link.
- **Video speed** in Create → Format speeds up every clip in a job, from 1.1× to 2×. Voices keep their pitch and captions stay in sync.
- TikTok accounts in automations. Each clip gets a review of its caption, audience, interactions and disclosures before it can post.
- **Economy** clipping mode, which uses lower-cost models and skips AI vision checks.
- **Advanced** clipping mode, for choosing your own transcription and planning models from OpenRouter.
- A **Posts** page with your posting history.
- Run stats that compare time and cost with OpusClip when there's enough information for a fair comparison.
- New app icons.

### Changed

- Captions are placed more carefully around faces.
- Jobs with a start and end time only transcribe that part of the video, which is faster and cheaper.
- Accounts, Automations and Jobs are more compact, and menus and confirmation dialogs work with the keyboard.
- Clip cost details name both transcription models when a job switches models partway through.
- Setting up a Zernio profile, and recovering from access problems, is clearer in Accounts.

### Fixed

- Automations could post the same clip twice after a slow or failed response.
- A clip you return to the automation queue after checking it by hand can post again.
- A scheduled slot stays free when a changed clip's TikTok approval is withdrawn, so you can review it and still post on time.
- Automation retries no longer stop at transcription with an HTTP 400 error.
- Page shortcuts no longer close a post dialog while it's uploading.
- Starting a job no longer fails on some IPv6 networks.
- Windows: Python is found reliably, edits with many cuts work, and saved results are opened safely.
- Exports whose audio drifts out of sync are caught before they're saved.

## [0.1.16] - 2026-09-24

### Added

- BridgeClip's source code is public under the MIT license. Installers start with 0.1.17.

[Unreleased]: https://github.com/bridge-mind/bridgeclip/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.2.0
[0.1.19]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.19
[0.1.18]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.18
[0.1.17]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.17
[0.1.16]: https://github.com/bridge-mind/bridgeclip/tree/7107574215cc7f1d4059d10d62bd82014a3ba46f

# Releasing BridgeClip

BridgeClip source and official downloads live in `bridge-mind/bridgeclip`. Tests, package rehearsals, signing, and publication run in the maintainer's private automation repository. Public GitHub repositories cannot make Actions logs private. Public Actions execution is disabled; no signing credentials belong in this repository.

The primary maintainers set the project's direction and review contributions under [CONTRIBUTING.md](../CONTRIBUTING.md). Main requires a pull request and the configured checks; release tags cannot be moved or deleted. Anyone can open a pull request from a fork; only the maintainer can push branches or merge. Public source can still be forked under the MIT license. Administrators can change access policy, so review collaborators and automation access before each release.

## Fork releases (unsigned)

This fork (`45thhokage/bridgeclip`) ships its own unsigned packages so the local transcription and clip-planning work can be used without building from source. They are **not** official BridgeMind releases: no Apple Developer ID, no Authenticode certificate, no notarization, and no upstream support. Upstream keeps public Actions disabled; this fork enables Actions for these builds only.

[`.github/workflows/fork-release.yml`](../.github/workflows/fork-release.yml) packages every platform on a `v*` tag push, or on demand (**Actions → Fork release → Run workflow**) for a tag that already exists — which is how a release is built from a tag that predates the workflow file.

| Target | Artifacts |
| --- | --- |
| Windows x64 | `BridgeClip-<version>-win-x64.exe` (NSIS) and `BridgeClip-<version>-win-x64.zip` (portable: unzip and run `BridgeClip.exe`) |
| Linux x64 | `BridgeClip-<version>-linux-x64.AppImage` (portable) and `BridgeClip-<version>-linux-x64.deb` |
| macOS arm64 / x64 | `BridgeClip-<version>-mac-<arch>.dmg` and `.zip` (the ZIP is the portable form) |

Each job stages the pinned Python, FFmpeg and yt-dlp runtimes from `scripts/release/runtime-lock.json` (`scripts/release/stage-runtime.py` on Windows and Linux, `scripts/prepare-resources.sh` on macOS), runs `npm run build`, then packages with `electron-builder.yml` after the workflow rewrites that file in the disposable checkout. The publish job merges the two macOS updater feeds (`scripts/merge-update-metadata.cjs`), writes `SHA256SUMS.txt`, reuses the version's `CHANGELOG.md` section as the release body, marks the release latest, and attaches the packages plus `latest.yml`, `latest-linux.yml` and `latest-mac.yml`.

macOS x64 needs an Intel runner (`macos-26-intel` by default, a paid larger runner on some plans). Set the `MAC_X64_RUNNER` repository variable to another Intel label, or let that matrix entry fail: the other three targets still publish, and the mac feed then describes one architecture (`merge-update-metadata.cjs` verifies every byte it lists either way).

Fork packaging deliberately differs from upstream:

- **Unsigned.** Windows shows a SmartScreen warning; macOS blocks the first launch until the user right-clicks the app and chooses **Open**.
- **Auto-updates come from this fork's releases.** The workflow replaces `publish.owner`/`publish.repo` with this repository, so a fork build never follows upstream's feed. Unsigned Windows installers cannot pass publisher verification, so fork builds set `win.verifyUpdateCodeSignature: false`; macOS keeps auto-update off because the app is not signed by team `9CBJCDR3J2`; Linux updates normally.
- **No bundled models or local runtime.** Packages carry the cloud engine runtime (`engine/requirements.lock`) only. Local transcription needs the documented locked install ([Local transcription](../README.md#local-transcription)), and transcription models are always downloaded in the app from **Settings → Local setup**. Local clip planning connects to a server the user already runs and downloads no model.
- **FFmpeg corresponding source is mirrored once.** Run **Mirror FFmpeg corresponding source** (`.github/workflows/fork-sources.yml`) to copy the version-pinned archives from an upstream release into a `sources-ffmpeg-<version>` release here. App releases link it instead of adding 3.4 GB per version. The mirror is only valid while `engine-bin`'s FFmpeg matches `scripts/release/runtime-lock.json`; re-mirror after an FFmpeg bump.
- **No detached signature, SBOM or artifact manifest.** `SHA256SUMS.txt` is generated from the uploaded bytes instead of the signed upstream manifest.

Fork releases live only on `https://github.com/45thhokage/bridgeclip/releases`. Never label them official, never publish into `bridge-mind/bridgeclip`, and keep the upstream process below for official releases.

## Packages

| System | Architecture | Download | Verification |
| --- | --- | --- | --- |
| macOS | Apple silicon, Intel | DMG and updater ZIP | Developer ID, team `9CBJCDR3J2`, notarized app and DMG, stapling, Gatekeeper |
| Windows | x64 | NSIS EXE | BRIDGEMIND LLC Authenticode signatures; timestamp; installed runtime smoke |
| Linux | x64 | AppImage and DEB | Installed/extracted runtime smoke; signed checksum manifest |

Version `v0.1.19` targets all four platform/architecture builds in one release, including the first Linux packages. Publication is gated on successful native tests, package acceptance, signatures and complete source archives; use the published release assets as the availability record. Windows ARM64 and Linux ARM64 are not release targets. Do not advertise an unsupported OS version based only on the build runner version.

## Maintainer sequence

1. Review the public commit, dependency notices, and generated inventories. Do not publish pre-BridgeClip private history. The existing export script remains available for constructing a clean public source snapshot.
2. Run private CI for the exact 40-character source commit. It runs macOS, Windows, and Linux checks plus macOS/Linux Electron end-to-end tests without signing credentials. The private source watcher checks main and maintainer-owned pull requests periodically; dispatch manually for an immediate run.
3. Run the private package rehearsal for that commit. This exercises native packaging and the relocated clipping runtime without publishing unsigned packages.
4. The version-bump PR also moves `CHANGELOG.md`'s Unreleased entries into a dated `X.Y.Z` section, as described in [Changelog](../CONTRIBUTING.md#changelog); the release tests fail without it. Create an immutable `vX.Y.Z` tag on reviewed main, matching `package.json`. Dispatch the private release workflow from its protected main branch with `platform=all`, `macos`, `windows`, or `linux`. The version tag stays the same format regardless of platform. The workflow resolves `refs/tags/<tag>`, checks main ancestry and version, freezes one commit, and runs CI again for that exact commit.
5. Selected release jobs stage runtimes, build packages, sign/notarize them, and test the packaged clipping engine. A macOS selection always builds Apple silicon and Intel. Windows acceptance installs the actual NSIS artifact and checks its publisher. Linux acceptance installs the DEB and extracts the AppImage. A captioned H.264 clip at 2× speed must retain audio and have the expected duration.
6. Publication requires every package for the selected platform, or all four platform/architecture builds for `all`. It verifies updater hashes against final bytes, merges macOS metadata when selected, creates a manifest recording the platform, adds the reviewed FFmpeg corresponding-source archive, and signs checksums using the separate release key. It rechecks the source tag, creates a draft, downloads every uploaded asset again, and compares every digest. With publication selected, only then does the draft become public. A later release for another platform needs a new version tag; published release bytes are never overwritten.
7. Never overwrite a published version. Fixes use a new version/tag. An incomplete upload remains a draft; investigate before explicitly removing a failed draft and retrying. Withdraw a bad public version and replace it with a higher version so installed updaters can recover. To withdraw one, delete it, turn it back into a draft, or mark it as a prerelease. A newer release for a different platform is not enough: when the latest release lacks a platform's feed, the updater picks that platform's highest published version, whichever release GitHub marks latest.

The website's download buttons resolve the newest published release with installers for each platform, and it links to [GitHub Releases](https://github.com/bridge-mind/bridgeclip/releases). The updater (`src/main/auto-updater.ts`) reads `latest-mac.yml`, `latest.yml`, or `latest-linux.yml` from the release GitHub marks as latest. When that release doesn't ship the running platform, which happens after a single-platform release, `src/main/update-provider.ts` falls back to the newest published release that has the platform's feed, so platforms can ship on separate schedules. Always publish with **Set as the latest release** (the workflow does), never as a prerelease: prereleases are ignored.

Installed apps check about 15 seconds after launch and then every four hours, download in the background, and install on **Restart to update** or the next quit. Updates are off for unpackaged builds, for macOS builds not signed by team `9CBJCDR3J2`, for a macOS app running from its disk image or quarantine, and when `BRIDGECLIP_DISABLE_AUTO_UPDATE=1`. Test a real signed update from the first installed version to the next before claiming update acceptance; a packaging rehearsal does not prove an upgrade path.

## Runtime reproduction

macOS: `bash scripts/prepare-resources.sh arm64` on Apple silicon, or `x64` on Intel. This builds LGPL FFmpeg and stages its caption libraries and licenses.

Windows/Linux x64: `python scripts/release/stage-runtime.py` from a clean checkout. Windows requires Visual C++ build tools for the relocatable yt-dlp launcher. Linux requires `patchelf`. Python and FFmpeg downloads are pinned by SHA-256 in `scripts/release/runtime-lock.json`. An HTTPS mirror may be selected with `BRIDGECLIP_FFMPEG_MIRROR`, preserving the same digest checks. Upstream FFmpeg daily assets expire; official automation keeps a private mirror of the exact archives.

Run `npm ci`, application and engine tests, dependency audits, `npm run build`, then electron-builder for the native target. Official Windows builds use `scripts/release/windows-config.cjs` with Azure signing configuration and `forceCodeSigning`; unsigned developer packages must never be labeled official releases.

`scripts/release/verify-runtime.py <packaged-resources-directory>` copies resources to a path containing spaces and tests the shipped Python, FFmpeg, framing model, captions, speed, audio, and downloader without relying on the checkout. `scripts/release/collect-artifacts.cjs` rejects missing platforms, mismatched versions, and altered artifacts.

Windows/Linux FFmpeg uses the LGPL shared upstream build, with OpenH264 for CPU encoding. Its LGPL version and dependency set differ from the minimal macOS build. macOS release jobs archive the exact FFmpeg source, bundled Homebrew library sources, formulas, patches, and license inventory for each architecture. The Windows `v0.1.18` release includes `ffmpeg-corresponding-source-win-x64.tar.xz`; private publication checks the archive's pinned SHA-256 and includes it in the signed checksum manifest. Linux publication still requires a reviewed corresponding-source distribution for its exact dependency set. A link to upstream build recipes alone is not that distribution.

## Verify a download

Obtain `resources/release-public-key.pub` from a trusted source checkout. Compare its fingerprint independently before first use; trusting a key downloaded beside an artifact alone does not establish authenticity.

Use OpenSSL 3 for this verification. On macOS, the built-in LibreSSL does not support this Ed25519 command; use the `openssl` executable from an OpenSSL 3 installation.

```sh
openssl pkeyutl -verify -rawin -pubin \
  -inkey resources/release-public-key.pub \
  -in SHA256SUMS.txt -sigfile SHA256SUMS.sig
shasum -a 256 --check SHA256SUMS.txt
```

The manifest records the exact public source commit. macOS and Windows also have operating-system code signatures. Linux checksum signatures can be verified manually; the current Electron updater uses HTTPS and generated SHA-512 metadata and does not verify this detached signature itself.

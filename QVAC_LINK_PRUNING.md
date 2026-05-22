# QVAC Native Addon Pruning — Design Notes

How this repo prunes unused QVAC native addons out of the iOS/Android build, what we ended up shipping, and what we'd revisit if upstream tooling changes.

## Result

iOS Debug build for `keet-translations` on a physical device (iPhone 15 Pro Max), with the worker only registering `nmtPlugin`:

- **App: 168 MB** (Frameworks: 160 MB)
- **Saved ~141 MB** of `ios-arm64` native binaries that `react-native-bare-kit`'s default linker would have embedded from unused QVAC plugins (`@qvac/diffusion-cpp`, `@qvac/embed-llamacpp`, `@qvac/llm-llamacpp`, `@qvac/ocr-onnx`, `@qvac/onnx`, `@qvac/transcription-parakeet`, `@qvac/transcription-whispercpp`, `@qvac/tts-onnx`).
- **JS bundle: 7.9 MB** (down from 8.7 MB once we trimmed the SDK patch — see below).
- **Translation works end-to-end**: model downloads (~37 MB), `translated {"language": "en", "result": "It's a nice day today"}`.

## Goal

`react-native-bare-kit` autolinks every package marked `addon: true` anywhere in `node_modules`, regardless of what the bundle actually uses. For a worker that only translates, that pulls in the entire QVAC plugin matrix. The fix prunes both sides: the JS bundle (so unused plugin code never gets traced) and the native link step (so unused frameworks never get embedded).

## Why we couldn't just reuse the SDK linker pattern

`@qvac/sdk/expo/plugins/patches/{ios,android}-link.mjs` implements a manifest-driven include-list:

```js
pkg = { name: 'qvac-addon-linker', dependencies: Object.fromEntries(addons.map(n => [n, '*'])) }
```

`bare-link` resolves each dependency via standard npm semantics from `projectRoot/node_modules`. That works for SDK-bundled apps because `qvac bundle sdk` produces a hoisted layout — every `addon: true` reference resolves to the top-level copy.

`keet-package` on the other hand **does not hoist**. We end up with multiple versions side by side:

```
node_modules/bare-tls@2.2.3                          ← top-level
node_modules/bare-fetch/node_modules/bare-tls@3.1.5  ← what the bundle traced against
```

The SDK linker hands `bare-link` the dependency name `bare-tls`, which resolves to the top-level 2.2.3 and emits `bare-tls.2.2.3.framework`. The bundle requires `linked:bare-tls.3.1.5.framework/bare-tls.3.1.5`. ADDON_NOT_FOUND.

The SDK linker has never been stress-tested against bundlers that emit nested versions because the SDK's own bundler hoists everything.

## What we shipped instead

**Exclude-list manifest, link-everything-then-prune linker.**

1. `qvac.config.json` (project root) — declares the SDK plugin module specifiers this app uses, following the same schema `qvac bundle sdk` already consumes:

   ```json
   { "plugins": ["@qvac/sdk/nmtcpp-translation/plugin"] }
   ```

2. `scripts/generate-addons-manifest.mjs` — for each plugin specifier, resolves the SDK plugin source file via `package.json#exports`, scans its imports for `@qvac/*` packages with `addon: true`, and unions them into the QVAC addon allow-list. Then walks `node_modules` for every `addon: true` package and splits into a keep-list (everything plus the resolved QVAC addons) and `excludePackages` (the `@qvac/*` packages the user didn't ask for). Writes `qvac/addons.manifest.json`. Runs after every `npm run bundle`.
3. `patches/react-native-bare-kit+0.14.0.patch` — patches `ios/link.mjs` and `android/link.mjs` to call `bare-link(projectRoot, opts)` with `pkg = null` (the package's original "link every `addon: true` recursively" behaviour), then delete xcframeworks whose package name appears in `excludePackages`.

Because the link step uses the original recursive-walk semantics, every nested copy gets linked at its real installed version. Both `bare-tls.2.2.3.framework` and `bare-tls.3.1.5.framework` end up in the app, the bundle finds the version it traced against, and only the explicitly excluded `@qvac/*` plugin frameworks are dropped.

JS-side pruning is handled separately by:

- `node_modules/@holepunchto/bare-translations/worker/translations.js` (patched to defensively `if (!hasPlugin(nmtPlugin.modelType)) registerPlugin(nmtPlugin)` so the SDK doesn't fall back to its default worker).
- `patches/@holepunchto+bare-translations++@qvac+sdk+0.11.0.patch` — strips RAG handlers from `handler-registry.js`, `handlers/index.js`, and `worker-core.js`. RAG isn't a plugin yet, so it can't be pruned via `qvac/addons.config.json`.
- `patches/@qvac+diagnostics+0.1.1.patch` — replaces a `try { require('bare-os') } catch { require('os') }` pattern in `@qvac/diagnostics` with a direct require so `bare-pack`'s static analysis doesn't trip on the `os` builtin.

### `qvac.config.json` drives the linker, not the worker

Important gotcha: in this app's setup, `qvac.config.json#plugins` feeds the manifest generator, which feeds the linker's exclude list. **It does not register plugins in the worker.** The worker (`node_modules/@holepunchto/bare-translations/worker/translations.js`) registers `nmtPlugin` by hand via the patched `if (!hasPlugin(nmtPlugin.modelType)) registerPlugin(nmtPlugin)` line. That registration is load-bearing for a different reason: it stops the SDK's `loadWorkerEntry()` fallback from loading the default worker, which would otherwise `registerPlugin()` every built-in plugin and statically pull their JS into the bundle.

This is a divergence from `qvac bundle sdk`, where the same `qvac.config.json#plugins` is the single source of truth for both the linker manifest *and* a generated `worker.entry.mjs` that auto-registers each plugin. We can't reuse that here because the app uses `bare-translations`'s own worker (with its own RPC handlers), not the SDK's generated worker.

**Practical implication:** when adding or removing a plugin, the user must update *two* places:

1. `qvac.config.json` — so the linker keeps the right `@qvac/*` xcframework.
2. `worker/translations.js` — so the worker actually `registerPlugin()`s it (or doesn't).

If the two drift apart, the failure mode is one of:

- Plugin in config but not in worker → xcframework linked but never used (silent waste).
- Plugin in worker but not in config → linker drops the xcframework, runtime fails with `ADDON_NOT_FOUND`.

A future improvement would be having the generator also emit a `qvac/registered-plugins.js` helper that the worker imports, collapsing both back to a single source of truth. The right long-term fix is for `bare-translations` (and similar pre-built worker packages) to consume `qvac.config.json` directly — at which point this two-step dance disappears.

### A/B: cost of leaving RAG in (no SDK patch at all)

We tested removing the SDK patch entirely (RAG handlers stay in) to measure what the patch is buying:

| | With SDK patch (RAG stripped) | Without SDK patch (RAG present) | Delta |
|---|---|---|---|
| Worker JS bundle (`translations.bundle.js`) | **7.9 MB** | 8.9 MB | **+1.0 MB JS** |
| Linked native frameworks (count) | 33 | 33 | 0 |
| Linked native frameworks (size) | 160 MB | 160 MB | 0 |
| Total `addon: true` packages reachable in `node_modules` | 41 | 41 | 0 |

RAG is JS-only bloat in this workflow: HyperDB transitively requires `rocksdb-native`, which is already in our keep-list (it's needed by other parts of the bundle), so RAG doesn't pull any new native dependencies. The ~1 MB JS bundle delta is what ships inside a release IPA when RAG is left in. In Debug builds (Metro serves JS live), the `.app` size is identical at 168 MB regardless of the patch — only the served bundle differs.

### Why we dropped the rest of the SDK patch

The original SDK patch had two extra hunks we initially assumed were necessary:

1. `bare-client.js` — rewriting the default-worker fallback path to use `import.meta.asset()`.
2. `worker.js` — narrowing the SDK's default plugin-registration block to just `nmtPlugin`.

Both were redundant once we proved the runtime flow:

- The defensive `hasPlugin(nmtPlugin.modelType)` check in our worker registers `nmtPlugin` *before* the SDK's `loadWorkerEntry()` ever fires, so the default-worker fallback is never reached at runtime. (1) was protecting a dead branch.
- The SDK's default `worker.js` is loaded via a string-concatenated dynamic `import()` (`"../../server/" + "worker.js"`), which `bare-pack`'s static analyser does **not** trace. So the 8 plugin imports inside it never end up in the bundle. (2) was stripping imports that were already invisible to the bundler.

Trimming the patch shrank the JS bundle from 8.7 MB → 7.9 MB and reduced the SDK patch from 99 → 64 lines.

## What would simplify this

In rough order of impact:

- **`react-native-bare-kit` adopts the manifest natively.** Today every consumer (the SDK, this repo) patches the same two `link.mjs` files. If `react-native-bare-kit` read `qvac/addons.manifest.json` (or a generic `bare-addons.config.json`) directly, we'd ship the manifest only and drop the patch.
- **`keet-package` (or `bare-pack`) hoists, or emits a `name@version` manifest.** If the bundler resolved every `addon: true` reference to a single version, or wrote out the exact `(name, version)` pairs it traced, we could go back to a precise include-list and skip the link-then-delete dance.
- **`bare-link` accepts versioned dependency entries.** `dependencies: { "bare-tls": "3.1.5" }` resolving against nested copies would let the SDK's existing include-list pattern work for keet-package bundles without any extra patching.
- **The `--node-modules-addons` story stabilises.** If `keet-mobile` (or any app shell) propagated the sidecar `node_modules` to the worklet's asset resolver, `--node-modules-addons` would let the bundle declare exactly what it needs and the link-side patch becomes unnecessary.
- RAG becomes a real plugin

## File map

- `qvac.config.json` (project root) — declares which SDK plugin specifiers this app uses (same schema as `qvac bundle sdk`).
- `qvac/addons.manifest.json` — generated; `excludePackages` is what the linker reads.
- `scripts/generate-addons-manifest.mjs` — manifest generator; runs after `keet-package bundle`.
- `patches/react-native-bare-kit+0.14.0.patch` — patches the iOS and Android `link.mjs`.
- `patches/@holepunchto+bare-translations+1.0.0.patch` — defensive `hasPlugin()` check in `worker/translations.js` and removal of unexported `BERGAMOT_EN_ZH` / `BERGAMOT_ZH_EN` imports in `shared/models.js`.
- `patches/@holepunchto+bare-translations++@qvac+sdk+0.11.0.patch` — strips RAG handlers and the SDK's default-worker plugin block.
- `patches/@qvac+diagnostics+0.1.1.patch` — removes the `try { require('bare-os') } catch { require('os') }` pattern that broke `bare-pack` static analysis.
- `package.json` — `npm run bundle` chains `keet-package bundle … && node scripts/generate-addons-manifest.mjs`.

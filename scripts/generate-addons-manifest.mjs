#!/usr/bin/env node
/**
 * Generate qvac/addons.manifest.json for the patched react-native-bare-kit
 * linker.
 *
 * Source of truth is qvac.config.json (project root):
 *
 *   {
 *     "plugins": ["@qvac/sdk/nmtcpp-translation/plugin", ...]
 *   }
 *
 * Each plugin specifier points to a file inside @qvac/sdk that imports the
 * native-addon package(s) it needs. We resolve every spec, scan its imports
 * for `@qvac/*` packages whose package.json has `addon: true`, and treat the
 * union as the allow-list of QVAC plugin addons.
 *
 * The linker walks node_modules for *every* `addon: true` package and links
 * them all (preserving each package's actual installed version, even when a
 * bundler like keet-package leaves multiple nested copies side by side).
 * The manifest's job is to tell the linker which `@qvac/*` plugin packages
 * to drop afterwards. Non-`@qvac/*` addons (bare-fs, sodium-native, etc.)
 * are always kept — they are infrastructure, not optional plugins.
 *
 * For background see QVAC_LINK_PRUNING.md at the repo root.
 *
 * Run from the app root (or via `npm run bundle`):
 *   node scripts/generate-addons-manifest.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

const configPath = path.join(projectRoot, 'qvac.config.json')
const manifestDir = path.join(projectRoot, 'qvac')
const manifestPath = path.join(manifestDir, 'addons.manifest.json')
const nodeModulesRoot = path.join(projectRoot, 'node_modules')

let pluginSpecs = []
if (fs.existsSync(configPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (Array.isArray(parsed.plugins)) pluginSpecs = parsed.plugins
  } catch (err) {
    console.warn(`Could not parse ${configPath}: ${err.message}`)
  }
} else {
  console.warn(
    `No ${path.relative(projectRoot, configPath)} found. ` +
      `Without it, every @qvac/* plugin will be kept (no pruning).`
  )
}

function findInstalledPackage(pkgName) {
  const candidates = []
  function walk(nmDir) {
    if (!fs.existsSync(nmDir)) return
    const direct = path.join(nmDir, pkgName)
    if (fs.existsSync(path.join(direct, 'package.json'))) candidates.push(direct)

    let entries
    try {
      entries = fs.readdirSync(nmDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) {
        let scoped
        try {
          scoped = fs.readdirSync(path.join(nmDir, entry.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const inner of scoped) {
          if (!inner.isDirectory()) continue
          walk(path.join(nmDir, entry.name, inner.name, 'node_modules'))
        }
        continue
      }
      walk(path.join(nmDir, entry.name, 'node_modules'))
    }
  }
  walk(nodeModulesRoot)
  return candidates
}

function resolvePluginSpec(spec) {
  const m = spec.match(/^(@qvac\/sdk)\/(.+)$/)
  if (!m) {
    console.warn(`Skipping unsupported plugin spec: ${spec}`)
    return null
  }
  const subpath = m[2]
  for (const sdkDir of findInstalledPackage('@qvac/sdk')) {
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const exports_ = pkg.exports || {}
    const candidates = [
      `./${subpath}`,
      `./${subpath}.js`,
      `./${subpath}/index.js`
    ]
    for (const key of candidates) {
      const target = exports_[key]
      const file = typeof target === 'string'
        ? target
        : target && typeof target === 'object'
          ? target.import || target.default
          : null
      if (file) {
        const resolved = path.join(sdkDir, file)
        if (fs.existsSync(resolved)) return resolved
      }
    }
    const flat = path.join(sdkDir, 'dist/server/bare/plugins', subpath.replace(/\/plugin$/, ''), 'plugin.js')
    if (fs.existsSync(flat)) return flat
  }
  console.warn(`Could not resolve ${spec} on disk`)
  return null
}

function isAddonPackage(pkgName) {
  for (const dir of findInstalledPackage(pkgName)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (pkgJson.addon === true) return true
    } catch {}
  }
  return false
}

const qvacPluginAllowlist = new Set()
for (const spec of pluginSpecs) {
  const file = resolvePluginSpec(spec)
  if (!file) continue
  const source = fs.readFileSync(file, 'utf8')
  const importRe = /from\s+["'](@qvac\/[^"'/]+)(?:\/[^"']*)?["']/g
  let match
  while ((match = importRe.exec(source)) !== null) {
    const pkgName = match[1]
    if (pkgName === '@qvac/sdk') continue
    if (!isAddonPackage(pkgName)) continue
    qvacPluginAllowlist.add(pkgName)
  }
}

const addonPkgs = new Set()
function scan(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sub = path.join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      scan(sub)
      continue
    }
    const pkgJsonPath = path.join(sub, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
      if (pkgJson.addon === true) {
        addonPkgs.add(pkgJson.name || path.relative(nodeModulesRoot, sub))
      }
    } catch {}
  }
}
scan(nodeModulesRoot)

const allAddons = [...addonPkgs].sort()
const keep = []
const exclude = []
for (const pkg of allAddons) {
  if (pkg.startsWith('@qvac/')) {
    if (qvacPluginAllowlist.has(pkg)) keep.push(pkg)
    else exclude.push(pkg)
    continue
  }
  keep.push(pkg)
}

const out = {
  generatedAt: new Date().toISOString(),
  plugins: pluginSpecs,
  addons: keep,
  excludePackages: exclude
}

fs.mkdirSync(manifestDir, { recursive: true })
fs.writeFileSync(manifestPath, JSON.stringify(out, null, 2) + '\n')

console.log(
  `Wrote ${path.relative(projectRoot, manifestPath)}\n` +
    `  Plugins (${pluginSpecs.length}): ${pluginSpecs.join(', ') || '<none>'}\n` +
    `  Resolved QVAC addon allowlist (${qvacPluginAllowlist.size}): ${[...qvacPluginAllowlist].sort().join(', ') || '<none>'}\n` +
    `  Total kept (${keep.length}): ${keep.join(', ')}`
)
if (exclude.length > 0) {
  console.log(`  Excluded (${exclude.length}): ${exclude.join(', ')}`)
}

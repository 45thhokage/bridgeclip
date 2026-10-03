// Job 1 regression: the nested transcription object must merge (never reset
// unrelated fields to defaults), and the saved GPU/VRAM choice must survive a
// reload from disk ("app restart").
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(`${id.slice(2)}.ts`) : require(id), URL })
  return module.exports
}

/** settings-store with its own userData directory and a working fake keychain. */
function loadStore(userDataDir) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/settings-store.ts'), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === 'electron') {
        return {
          app: { getPath: (name) => name === 'home' ? path.join(userDataDir, 'home') : userDataDir, isReady: () => true },
          safeStorage: {
            isEncryptionAvailable: () => true,
            getSelectedStorageBackend: () => 'keychain',
            encryptString: (value) => Buffer.from(`safe:${value}`),
            decryptString: (buffer) => Buffer.from(buffer).toString('utf8').replace(/^safe:/, '')
          }
        }
      }
      if (id === '../shared/jev-settings') return loadShared('jev-settings.ts')
      if (id === '../shared/transcription') return loadShared('transcription.ts')
      return require(id)
    },
    URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main')
  })
  return module.exports
}

const LOCAL_CHOICE = { provider: 'local', gpuFamily: 'nvidia_pascal', vram: '8plus', localModelId: 'small.en' }

test('a saved GPU and VRAM choice survives a settings reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-transcription-settings-'))
  try {
    const store = loadStore(root)
    store.saveTranscriptionSettings(LOCAL_CHOICE)
    // Re-read from disk, as a fresh app start does.
    const reloaded = loadStore(root).loadSettings()
    // Cross-realm objects: compare fields, not prototypes.
    assert.equal(reloaded.transcription.provider, LOCAL_CHOICE.provider)
    assert.equal(reloaded.transcription.gpuFamily, 'nvidia_pascal')
    assert.equal(reloaded.transcription.vram, '8plus')
    assert.equal(reloaded.transcription.localModelId, 'small.en')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a partial transcription update merges instead of resetting other fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-transcription-merge-'))
  try {
    const store = loadStore(root)
    store.saveTranscriptionSettings(LOCAL_CHOICE)
    // The picker sends one changed field; the provider, VRAM and model must stay.
    store.saveTranscriptionSettings({ gpuFamily: 'nvidia_modern' })
    const merged = store.loadSettings().transcription
    assert.equal(merged.gpuFamily, 'nvidia_modern')
    assert.equal(merged.provider, 'local')
    assert.equal(merged.vram, '8plus')
    assert.equal(merged.localModelId, 'small.en')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a full settings save merges a partial transcription patch too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-transcription-public-'))
  try {
    const store = loadStore(root)
    store.saveTranscriptionSettings(LOCAL_CHOICE)
    const current = store.loadSettings()
    store.savePublicSettings({ ...store.publicSettings(current), transcription: { gpuFamily: 'nvidia_modern' } })
    const merged = store.loadSettings().transcription
    assert.equal(merged.gpuFamily, 'nvidia_modern')
    assert.equal(merged.provider, 'local')
    assert.equal(merged.vram, '8plus')
    assert.equal(merged.localModelId, 'small.en')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

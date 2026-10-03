// Clip-planning settings: legacy files migrate to cloud + OpenRouter, existing
// users skip the first-run card, and each stage resolves its own source for
// every mixed combination. No network, no live providers.
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

/** src/main/planning.ts with the settings store, network policy and fetch stubbed. */
function loadPlanning(
  fetchImpl = async () => { throw new Error('live calls are not allowed in tests') },
  settingsImpl = () => { throw new Error('save settings must be passed explicitly in tests') }
) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/planning.ts'), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require: (id) => {
      if (id === '../shared/planning') return loadShared('planning.ts')
      if (id === './http-response') return { readResponseText: async (response) => response.text() }
      if (id === './network-policy') return { assertPublicWebUrl: async () => {} }
      if (id === './settings-store') return { loadSettings: settingsImpl }
      return require(id)
    },
    URL, AbortSignal, Response, fetch: fetchImpl,
    process, Buffer, console, setTimeout, clearTimeout
  })
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
      if (id === '../shared/planning') return loadShared('planning.ts')
      return require(id)
    },
    URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main')
  })
  return module.exports
}

function baseSettings(patch = {}) {
  return {
    openrouterApiKey: '',
    zernioApiKey: '',
    jevEnabled: 'off',
    jevVisualContext: 'off',
    sourceContextWebResearch: 'off',
    outputDirectory: '/clips',
    pythonPath: 'python3',
    customVocabulary: '',
    transcription: { provider: 'openrouter', gpuFamily: 'unsure', vram: '4to7', localModelId: null },
    planning: {
      source: 'cloud',
      cloudProvider: 'openrouter',
      cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: '' },
      cloudBaseUrl: '',
      local: { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: '', contextTokens: 8192 }
    },
    opencodeZenApiKey: '',
    opencodeGoApiKey: '',
    planningCustomApiKey: '',
    planningLocalApiKey: '',
    ...patch
  }
}

const LOCAL_PLANNING = {
  source: 'local',
  cloudProvider: 'openrouter',
  cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: '' },
  cloudBaseUrl: '',
  local: { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3.1:8b', contextTokens: 8192 }
}

test('cloud planning with OpenRouter keeps the existing job-option path', () => {
  const planning = loadPlanning()
  const cloud = baseSettings({ openrouterApiKey: 'sk-or-test' })
  assert.equal(planning.planningUsesOpenRouter(cloud), true)
  const options = planning.planningJobOptions(cloud)
  assert.equal(options.planning_source, 'cloud')
  assert.equal(options.planning_provider, 'openrouter')
  assert.equal(options.planning_model_id, undefined)
  assert.equal(planning.planningKeyEnvironment(cloud).PLANNING_API_KEY, 'sk-or-test')
})

test('local transcription does not change how clip planning resolves', () => {
  const planning = loadPlanning()
  const localAudio = baseSettings({
    openrouterApiKey: 'sk-or-test',
    transcription: { provider: 'local', gpuFamily: 'nvidia_pascal', vram: '8plus', localModelId: 'small.en' }
  })
  const options = planning.planningJobOptions(localAudio)
  assert.equal(options.planning_source, 'cloud')
  assert.equal(options.planning_provider, 'openrouter')
})

test('OpenCode Zen planning resolves for cloud and local transcription alike', () => {
  const planning = loadPlanning()
  const zen = {
    openrouterApiKey: 'sk-or-test',
    opencodeZenApiKey: 'sk-zen-test',
    planning: {
      source: 'cloud',
      cloudProvider: 'opencode-zen',
      cloudModels: { openrouter: '', 'opencode-zen': 'gpt-5.2', 'opencode-go': '', custom: '' },
      cloudBaseUrl: '',
      local: LOCAL_PLANNING.local
    }
  }
  for (const transcription of [
    { provider: 'openrouter', gpuFamily: 'unsure', vram: '4to7', localModelId: null },
    { provider: 'local', gpuFamily: 'nvidia_pascal', vram: '8plus', localModelId: 'small.en' }
  ]) {
    const settings = baseSettings({ ...zen, transcription })
    const options = planning.planningJobOptions(settings)
    assert.equal(options.planning_source, 'cloud')
    assert.equal(options.planning_provider, 'opencode-zen')
    assert.equal(options.planning_model_id, 'gpt-5.2')
    assert.equal(options.planning_base_url, 'https://opencode.ai/zen/v1')
    assert.equal(planning.planningUsesOpenRouter(settings), false)
    assert.equal(planning.planningKeyEnvironment(settings).PLANNING_API_KEY, 'sk-zen-test')
  }
})

test('local planning resolves the host, port and context for either transcription source', () => {
  const planning = loadPlanning()
  for (const transcription of [
    { provider: 'openrouter', gpuFamily: 'unsure', vram: '4to7', localModelId: null },
    { provider: 'local', gpuFamily: 'nvidia_pascal', vram: '8plus', localModelId: 'small.en' }
  ]) {
    const settings = baseSettings({ transcription, planning: LOCAL_PLANNING })
    const options = planning.planningJobOptions(settings)
    assert.equal(options.planning_source, 'local')
    assert.equal(options.planning_provider, 'local')
    assert.equal(options.planning_model_id, 'llama3.1:8b')
    assert.equal(options.planning_base_url, 'http://127.0.0.1:11434/v1')
    assert.equal(options.planning_local_host, '127.0.0.1')
    assert.equal(options.planning_local_port, 11434)
    assert.equal(options.planning_context_tokens, 8192)
    assert.equal(planning.planningUsesOpenRouter(settings), false)
    assert.equal(planning.planningKeyEnvironment(settings).PLANNING_API_KEY, undefined)
  }
})

test('an IPv6 loopback server resolves the unbracketed host the bridge compares', () => {
  const planning = loadPlanning()
  const shared = loadShared('planning.ts')
  // Node keeps the brackets in URL.hostname; the job options and the Python
  // bridge both see the bare literal.
  const ipv6 = { ...LOCAL_PLANNING.local, baseUrl: 'http://[::1]:11434/v1' }
  const options = planning.planningJobOptions(baseSettings({ planning: { ...LOCAL_PLANNING, local: ipv6 } }))
  assert.equal(options.planning_local_host, '::1')
  assert.equal(options.planning_local_port, 11434)
  assert.equal(options.planning_base_url, 'http://[::1]:11434/v1')
  assert.equal(shared.parsePlanningBaseUrl('http://[::1]:11434/v1').hostname, '::1')
  assert.equal(shared.isLoopbackPlanningHost('::1'), true)
})

test('a local address without a port resolves to the scheme default', () => {
  const planning = loadPlanning()
  const noPort = { ...LOCAL_PLANNING.local, baseUrl: 'http://localhost/v1' }
  const options = planning.planningJobOptions(baseSettings({ planning: { ...LOCAL_PLANNING, local: noPort } }))
  assert.equal(options.planning_local_host, 'localhost')
  assert.equal(options.planning_local_port, 80)
})

test('only the three documented loopback hosts are accepted for a local server', () => {
  const shared = loadShared('planning.ts')
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(shared.isLoopbackPlanningHost(host), true, host)
  }
  // The bridge's allowlist carries the same three names, so none of these may
  // pass the UI and fail later in the worker.
  for (const host of ['127.0.0.2', '192.168.1.10', 'localhost.example.com', '::2', '0.0.0.0']) {
    assert.equal(shared.isLoopbackPlanningHost(host), false, host)
  }
  const planning = loadPlanning()
  const other = { ...LOCAL_PLANNING.local, baseUrl: 'http://127.0.0.2:11434/v1' }
  assert.throws(() => planning.planningJobOptions(baseSettings({ planning: { ...LOCAL_PLANNING, local: other } })), /this computer/)
})

test('Test connection names a missing OpenCode key before the missing model', async () => {
  const planning = loadPlanning(async () => { throw new Error('no request is sent without a key') })
  const goPlanning = {
    source: 'cloud',
    cloudProvider: 'opencode-go',
    cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: '' },
    cloudBaseUrl: '',
    local: LOCAL_PLANNING.local
  }
  const noKey = await planning.testPlanningConnection('opencode-go', baseSettings({ planning: goPlanning }))
  assert.equal(noKey.ok, false)
  assert.equal(noKey.kind, 'incomplete')
  assert.match(noKey.message, /OpenCode Go key/)
  // With a key saved, the model is the thing left to fix.
  const withKey = await planning.testPlanningConnection('opencode-go', baseSettings({ opencodeGoApiKey: 'sk-go-test', planning: goPlanning }))
  assert.equal(withKey.ok, false)
  assert.equal(withKey.kind, 'incomplete')
  assert.match(withKey.message, /model/)
})

test('an unusable local or cloud planning target fails before a job is queued', () => {
  const planning = loadPlanning()
  const remote = baseSettings({ planning: { ...LOCAL_PLANNING, local: { ...LOCAL_PLANNING.local, baseUrl: 'http://192.168.1.10:11434/v1' } } })
  assert.throws(() => planning.planningJobOptions(remote), /this computer/)
  const noModel = baseSettings({ planning: { ...LOCAL_PLANNING, local: { ...LOCAL_PLANNING.local, modelId: '' } } })
  assert.throws(() => planning.planningJobOptions(noModel), /model/)
  const zenNoKey = baseSettings({
    planning: {
      source: 'cloud',
      cloudProvider: 'opencode-zen',
      cloudModels: { openrouter: '', 'opencode-zen': 'gpt-5.2', 'opencode-go': '', custom: '' },
      cloudBaseUrl: '',
      local: LOCAL_PLANNING.local
    }
  })
  assert.throws(() => planning.planningJobOptions(zenNoKey), /OpenCode Zen key/)
})

test('a provider model list loads before any model is chosen, and refresh re-reads it', async () => {
  const calls = []
  const settings = baseSettings({
    opencodeZenApiKey: 'sk-zen-live',
    planning: {
      source: 'cloud',
      cloudProvider: 'opencode-zen',
      // No model chosen yet: listing models is how the user picks one.
      cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: '' },
      cloudBaseUrl: '',
      local: LOCAL_PLANNING.local
    }
  })
  const planning = loadPlanning(async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization })
    return new Response(JSON.stringify({ data: [{ id: 'gpt-5.2' }, { id: 'free-model' }] }), { status: 200 })
  }, () => settings)
  const first = await planning.listPlanningModels(false, 'opencode-zen')
  assert.deepEqual([...first.models], ['gpt-5.2', 'free-model'])
  assert.equal(first.error, null)
  assert.equal(calls[0].url, 'https://opencode.ai/zen/v1/models')
  assert.equal(calls[0].auth, 'Bearer sk-zen-live')
  // The cached copy answers the second load; Refresh fetches again.
  await planning.listPlanningModels(false, 'opencode-zen')
  assert.equal(calls.length, 1)
  await planning.listPlanningModels(true, 'opencode-zen')
  assert.equal(calls.length, 2)
})

test('a local model list loads without a chosen model and refuses a remote server', async () => {
  const fetchModels = async () => new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }), { status: 200 })
  const local = baseSettings({ planning: { ...LOCAL_PLANNING, local: { ...LOCAL_PLANNING.local, modelId: '' } } })
  let current = local
  const planning = loadPlanning(fetchModels, () => current)
  const result = await planning.listPlanningModels(false, 'local')
  assert.deepEqual([...result.models], ['llama3.1:8b'])
  assert.equal(result.error, null)
  current = baseSettings({ planning: { ...LOCAL_PLANNING, local: { ...LOCAL_PLANNING.local, baseUrl: 'http://192.168.1.10:11434/v1' } } })
  const refused = await planning.listPlanningModels(true, 'local')
  assert.deepEqual([...refused.models], [])
  assert.match(refused.error, /this computer/)
})

test('a custom endpoint requires https and its own model id', () => {
  const planning = loadPlanning()
  const custom = {
    source: 'cloud',
    cloudProvider: 'custom',
    cloudModels: { openrouter: '', 'opencode-zen': '', 'opencode-go': '', custom: 'my-model' },
    cloudBaseUrl: 'https://planner.example.com/v1',
    local: LOCAL_PLANNING.local
  }
  const options = planning.planningJobOptions(baseSettings({ planning: custom }))
  assert.equal(options.planning_provider, 'custom')
  assert.equal(options.planning_base_url, 'https://planner.example.com/v1')
  assert.equal(options.planning_model_id, 'my-model')
  assert.throws(
    () => planning.planningJobOptions(baseSettings({ planning: { ...custom, cloudBaseUrl: 'http://planner.example.com/v1' } })),
    /https/
  )
})

test('a legacy settings file migrates to cloud + OpenRouter and skips the setup card', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-planning-migration-'))
  try {
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    // Version 13 (no `planning` key): an existing user with a saved OpenRouter key.
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
      version: 13,
      openrouterApiKey: { scheme: 'safeStorage', value: Buffer.from('safe:sk-or-legacy').toString('base64') },
      outputDirectory: path.join(root, 'clips'),
      pythonPath: 'python',
      transcription: { provider: 'openrouter', gpuFamily: 'nvidia_pascal', vram: '8plus', localModelId: null }
    }))
    const store = loadStore(root)
    const settings = store.loadSettings()
    assert.equal(settings.planning.source, 'cloud')
    assert.equal(settings.planning.cloudProvider, 'openrouter')
    assert.equal(settings.planning.local.contextTokens, 8192)
    // The GPU picker from Job 1 keeps its saved value through this migration too.
    assert.equal(settings.transcription.gpuFamily, 'nvidia_pascal')
    const publicSettings = store.publicSettings(settings)
    const setup = loadShared('setup.ts')
    assert.equal(setup.needsFirstRunSetup({
      openrouterConfigured: publicSettings.openrouterConfigured,
      planningKeysConfigured: publicSettings.planningKeysConfigured,
      transcription: settings.transcription,
      planning: settings.planning
    }), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a fresh install gets defaults and shows the setup card until something is configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-planning-fresh-'))
  try {
    const store = loadStore(root)
    const settings = store.loadSettings()
    assert.equal(settings.planning.source, 'cloud')
    assert.equal(settings.planning.cloudProvider, 'openrouter')
    const setup = loadShared('setup.ts')
    assert.equal(setup.needsFirstRunSetup({
      openrouterConfigured: false,
      planningKeysConfigured: store.publicSettings(settings).planningKeysConfigured,
      transcription: settings.transcription,
      planning: settings.planning
    }), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a fully local setup also skips the first-run card', () => {
  const setup = loadShared('setup.ts')
  const localOnly = {
    openrouterConfigured: false,
    planningKeysConfigured: { openrouter: false, 'opencode-zen': false, 'opencode-go': false, custom: false, local: false },
    transcription: { localModelId: 'small.en' },
    planning: { local: { modelId: 'llama3.1:8b' } }
  }
  assert.equal(setup.needsFirstRunSetup(localOnly), false)
})

test('an OpenCode key is stored, reported as configured, and kept after a reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-opencode-key-'))
  try {
    const store = loadStore(root)
    const saved = store.replaceApiKey('opencodeZenApiKey', 'sk-zen-live')
    assert.equal(saved.planningKeysConfigured['opencode-zen'], true)
    assert.equal(saved.planningKeysConfigured['opencode-go'], false)
    // A fresh app start decrypts the saved key and still reports it as set.
    const reloadedStore = loadStore(root)
    const reloaded = reloadedStore.loadSettings()
    assert.equal(reloaded.opencodeZenApiKey, 'sk-zen-live')
    assert.equal(reloadedStore.publicSettings(reloaded).planningKeysConfigured['opencode-zen'], true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('saving one planning field keeps the rest of the saved planning settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-planning-merge-'))
  try {
    const store = loadStore(root)
    store.savePlanningSettings({ source: 'local' })
    const saved = store.loadSettings().planning
    assert.equal(saved.source, 'local')
    assert.equal(saved.cloudProvider, 'openrouter')
    assert.equal(saved.local.baseUrl, 'http://127.0.0.1:11434/v1')
    store.savePlanningSettings({ cloudModels: { 'opencode-zen': 'gpt-5.2' } })
    const merged = store.loadSettings().planning
    assert.equal(merged.source, 'local')
    assert.equal(merged.cloudModels['opencode-zen'], 'gpt-5.2')
    assert.equal(merged.cloudModels.openrouter, '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

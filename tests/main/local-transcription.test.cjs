'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function transpile(file) {
  const source = fs.readFileSync(file, 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function loadShared(file) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(path.join(__dirname, '../../src/shared', file)), {
    module, exports: module.exports,
    require: (id) => id.startsWith('./') ? loadShared(id.slice(2) + '.ts') : require(id)
  })
  return module.exports
}

const workHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-models-test-'))
process.on('exit', () => fs.rmSync(workHome, { recursive: true, force: true }))

const transcription = loadShared('transcription.ts')
const spawned = []

function loadLocalTranscription(overrides = {}) {
  const mocks = {
    electron: { app: { getPath: () => path.join(workHome, 'userData') } },
    child_process: {
      spawn: (command, args, options) => {
        const child = {
          pid: 4242,
          stdin: { on() {}, end(payload) { spawned.push(JSON.parse(payload)) } },
          stdout: null,
          stderr: null,
          on() {}
        }
        spawned.push({ command, args, options })
        return child
      },
      execFile: () => {}
    },
    './pipeline-runner': {
      getEnginePath: () => path.join(workHome, 'engine'),
      getBridgeRunnerPath: () => path.join(workHome, 'engine', 'bridge', 'bridge_runner.py'),
      resolvePythonPath: () => 'python',
      runtimeEnvironment: () => ({}),
      preflightCheck: () => ({ ok: true })
    },
    './settings-store': { loadSettings: () => settings() },
    './logger': { logger: { info() {}, warn() {}, error() {} } },
    '../shared/transcription': transcription,
    ...overrides
  }
  const module = { exports: {} }
  vm.runInNewContext(transpile(path.join(__dirname, '../../src/main/local-transcription.ts')), {
    module, exports: module.exports,
    require: (id) => (id in mocks ? mocks[id] : require(id)),
    process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    __dirname: path.join(__dirname, '../../src/main')
  })
  return module.exports
}

function settings(overrides = {}) {
  return {
    outputDirectory: workHome,
    pythonPath: 'python',
    transcription: {
      provider: 'local',
      gpuFamily: 'nvidia_pascal',
      vram: '8plus',
      localModelId: 'distil-large-v3.5',
      ...overrides
    }
  }
}

test('model directories stay inside the app data models folder', () => {
  const local = loadLocalTranscription()
  const root = path.resolve(local.modelsRoot())
  for (const id of transcription.LOCAL_TRANSCRIPTION_MODEL_IDS) {
    const dir = path.resolve(local.modelDirectory(id))
    assert.equal(dir, path.join(root, id))
    assert.ok(dir.startsWith(`${root}${path.sep}`))
  }
})

test('downloads and deletes reject ids that are not in the catalog', () => {
  const local = loadLocalTranscription()
  for (const value of ['../../escape', '..\\..\\escape', 'not-in-catalog', '', null, 42, {}]) {
    assert.throws(() => local.deleteModel(value), /Unknown local transcription model/, String(value))
    assert.equal(local.startModelDownload(value, () => {}).ok, false, String(value))
    assert.throws(() => local.modelDirectory(value), /Unknown local transcription model/, String(value))
  }
})

test('a download sends the catalog repository, revision and an in-root folder', () => {
  const local = loadLocalTranscription()
  spawned.length = 0
  const started = local.startModelDownload('distil-large-v3.5', () => {})
  assert.equal(started.ok, true)
  const request = spawned.find((entry) => entry.command)
  assert.equal(request.command, 'python')
  assert.equal(request.args.at(-1), path.join(workHome, 'engine', 'bridge', 'bridge_runner.py'))
  const payload = spawned.find((entry) => entry.command === 'download_model')
  const catalog = transcription.localModel('distil-large-v3.5')
  assert.equal(payload.command, 'download_model')
  assert.equal(payload.repo, catalog.repo)
  assert.equal(payload.revision, catalog.revision)
  assert.equal(payload.approx_size_mb, catalog.approxSizeMB)
  assert.equal(path.resolve(payload.model_dir), path.join(path.resolve(local.modelsRoot()), 'distil-large-v3.5'))
  // One download at a time.
  assert.equal(local.startModelDownload('small.en', () => {}).ok, false)
})

test('deleting a model removes only that model folder', () => {
  const local = loadLocalTranscription()
  const keep = local.modelDirectory('small.en')
  const remove = local.modelDirectory('distil-large-v3.5')
  fs.mkdirSync(keep, { recursive: true })
  fs.mkdirSync(remove, { recursive: true })
  fs.writeFileSync(path.join(keep, 'model.bin'), 'keep')
  fs.writeFileSync(path.join(remove, 'model.bin'), 'remove')
  assert.equal(local.deleteModel('distil-large-v3.5'), 'distil-large-v3.5')
  assert.equal(fs.existsSync(remove), false)
  assert.equal(fs.existsSync(path.join(keep, 'model.bin')), true)
})

test('job options use the catalog model and the recommended device', () => {
  const local = loadLocalTranscription()
  // Not downloaded yet.
  assert.throws(() => local.localTranscriptionJobOptions(settings()), /Download the selected local transcription model/)
  const dir = local.modelDirectory('distil-large-v3.5')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), '{}')
  // JSON compare: vm-realm objects have a different prototype than this realm's.
  assert.equal(JSON.stringify(local.localTranscriptionJobOptions(settings())), JSON.stringify({
    transcription_provider: 'local',
    local_transcription_model_id: 'distil-large-v3.5',
    local_transcription_model_dir: dir,
    local_transcription_backend: 'faster-whisper',
    local_transcription_device: 'cuda',
    local_transcription_compute_type: 'int8'
  }))
  // OpenRouter keeps the default path with no local options at all.
  assert.equal(JSON.stringify(local.localTranscriptionJobOptions(settings({ provider: 'openrouter', localModelId: null }))), '{}')
})

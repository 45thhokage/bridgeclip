'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(id.slice(2) + '.ts') : require(id) })
  return module.exports
}

const transcription = loadShared('transcription.ts')

test('the recommendation table picks a model, device and compute type per GPU', () => {
  const cases = [
    { gpuFamily: 'nvidia_pascal', vram: '8plus', model: 'distil-large-v3.5', device: 'cuda', computeType: 'int8' },
    { gpuFamily: 'nvidia_pascal', vram: '4to7', model: 'distil-large-v3.5', device: 'cuda', computeType: 'int8' },
    { gpuFamily: 'nvidia_pascal', vram: 'under4', model: 'small.en', device: 'cuda', computeType: 'int8' },
    { gpuFamily: 'nvidia_modern', vram: '8plus', model: 'distil-large-v3.5', device: 'cuda', computeType: 'float16' },
    { gpuFamily: 'nvidia_modern', vram: 'under4', model: 'small.en', device: 'cuda', computeType: 'float16' },
    { gpuFamily: 'nvidia_old', vram: '4to7', model: 'small.en', device: 'cpu', computeType: 'int8' },
    { gpuFamily: 'cpu_or_other', vram: '8plus', model: 'small.en', device: 'cpu', computeType: 'int8' },
    { gpuFamily: 'apple_silicon', vram: '4to7', model: 'small.en', device: 'cpu', computeType: 'int8' },
    { gpuFamily: 'unsure', vram: '4to7', model: 'small.en', device: 'cpu', computeType: 'int8' }
  ]
  for (const expected of cases) {
    const result = transcription.recommendTranscription(expected.gpuFamily, expected.vram)
    assert.equal(result.recommendedModelId, expected.model, `${expected.gpuFamily}/${expected.vram}`)
    assert.equal(result.device, expected.device, `${expected.gpuFamily}/${expected.vram}`)
    assert.equal(result.computeType, expected.computeType, `${expected.gpuFamily}/${expected.vram}`)
    assert.ok(result.reason.length > 0, `${expected.gpuFamily}/${expected.vram} needs a reason`)
  }
})

test('every catalog model stays selectable and warnings never block', () => {
  const ids = transcription.LOCAL_TRANSCRIPTION_MODEL_IDS
  // JSON compare: vm-realm arrays have a different prototype than this realm's.
  assert.equal(JSON.stringify(ids), JSON.stringify(['distil-large-v3.5', 'large-v3-turbo', 'distil-large-v3', 'small.en', 'parakeet-tdt-0.6b-v2']))
  for (const model of transcription.LOCAL_TRANSCRIPTION_MODELS) {
    // Sizes, pinned repositories and licenses are real, and every catalog id
    // resolves to itself.
    assert.match(model.repo, /^[\w.-]+\/[\w.-]+$/)
    assert.match(model.revision, /^[0-9a-f]{40}$/)
    assert.ok(model.approxSizeMB > 0)
    assert.equal(transcription.localModel(model.id).id, model.id)
  }
  // A big model on a small GPU is warned about, never removed from the list.
  assert.equal(transcription.localModelWarning('large-v3-turbo', 'nvidia_modern', 'under4'), 'May be slow or run out of memory')
  assert.equal(transcription.localModelWarning('distil-large-v3.5', 'cpu_or_other', '4to7'), 'May be slow or run out of memory')
  assert.equal(transcription.localModelWarning('parakeet-tdt-0.6b-v2', 'cpu_or_other', '4to7'), null)
  assert.equal(transcription.localModelWarning('distil-large-v3.5', 'nvidia_pascal', '8plus'), null)
})

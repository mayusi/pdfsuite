import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePdf } from '../src/pdf/parse.js'
import { readFields, fillForm } from '../src/pdf/forms.js'
import { extractText } from '../src/pdf/ops.js'

// reportlab-generated fixture with text / multiline / checkbox / radio / combo fields
const FIXTURE = 'test/fixtures/form2.pdf' // regenerate: python test/fixtures/genforms.py
let bytes = null
try { bytes = new Uint8Array(readFileSync(FIXTURE)) } catch { /* fixture is generated locally */ }

describe('forms', { skip: !bytes && 'form fixture not generated' }, () => {
  it('reads every field type with widget geometry', async () => {
    const f = readFields(await parsePdf(bytes))
    assert.deepEqual(f.map((x) => [x.name, x.type]), [['name', 'text'], ['notes', 'text'], ['agree', 'checkbox'], ['size', 'radio'], ['color', 'combo']])
    assert.equal(f.find((x) => x.name === 'color').options.length, 3)
    assert.equal(f.find((x) => x.name === 'size').widgets.length, 2)
    const nw = f[0].widgets[0]
    assert.deepEqual([nw.page, Math.round(nw.rect.x), Math.round(nw.rect.y), Math.round(nw.rect.w)], [0, 80, 30, 200])
  })
  it('fills values that read back, with appearances', async () => {
    const out = await fillForm(bytes, { name: 'Jane Café', agree: true, size: 'L', color: 'Blue', notes: 'a\nb' })
    const f = readFields(await parsePdf(out))
    const v = Object.fromEntries(f.map((x) => [x.name, x.value]))
    assert.deepEqual(v, { name: 'Jane Café', notes: 'a\nb', agree: true, size: 'L', color: 'Blue' })
  })
  it('flattens: values become page text, fields disappear', async () => {
    const out = await fillForm(bytes, { name: 'Flat Value' }, { flatten: true })
    const doc = await parsePdf(out)
    assert.equal(readFields(doc).length, 0)
    assert.match((await extractText(doc))[0], /Flat Value/)
  })
})

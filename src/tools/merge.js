import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, FileList } from '../ui/widgets.js'
import { mergePdfs } from '../pdf/ops.js'

export function Merge() {
  let files = []
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const move = (from, to) => {
    const c = [...files]
    const [x] = c.splice(from, 1)
    c.splice(to, 0, x)
    files = c
    render()
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const inputs = await Promise.all(files.map(readBytes))
      const out = await mergePdfs(inputs)
      saveBlob(new Blob([out], { type: 'application/pdf' }), 'merged.pdf')
    } catch (e) {
      error = e.message || 'merge failed — is every file a valid PDF?'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    setKids(root, 
      DropZone({
        accept: 'application/pdf',
        multiple: true,
        onFiles: (f) => {
          files = files.concat(f)
          render()
        },
      }),
      files.length ? Card(FileList({ files, onMove: move, onRemove: (i) => { files = files.filter((_, j) => j !== i); render() } })) : null,
      ErrorText(error),
      Btn(busy ? 'Merging…' : `Merge ${files.length} PDFs`, { onclick: run, disabled: busy || files.length < 2 }),
    )
  }
  render()
  return root
}

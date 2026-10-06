// Tool catalogue — metadata only (no view imports), so tools can link to
// each other ("continue with…") without import cycles.

export const CATS = [
  { id: 'edit', name: 'Edit & sign', color: 'var(--c-edit)' },
  { id: 'organize', name: 'Organize', color: 'var(--c-organize)' },
  { id: 'convert', name: 'Convert', color: 'var(--c-convert)' },
  { id: 'secure', name: 'Optimize & protect', color: 'var(--c-secure)' },
]

export const CATALOG = [
  { id: 'edit', cat: 'edit', name: 'Edit PDF', icon: 'pencil', desc: 'Change existing text, add text, images, shapes and drawings', kw: 'annotate write draw text modify change typo' },
  { id: 'studio', cat: 'edit', name: 'Design & Edit', icon: 'brush', desc: 'Photo editor and designer: layers, brushes, selections, filters, text, templates — open photos or PDF pages', kw: 'photo image editor pixlr photoshop design canva layers brush filter retouch background remove poster thumbnail template', isNew: true },
  { id: 'sign', cat: 'edit', name: 'Sign PDF', icon: 'signature', desc: 'Draw, type or upload your signature and place it', kw: 'signature esign autograph initials', route: 'edit?mode=sign' },
  { id: 'fill', cat: 'edit', name: 'Fill forms', icon: 'form', desc: 'Type into PDF form fields, tick boxes, flatten', kw: 'acroform fields fillable', route: 'edit?mode=fill' },
  { id: 'redact', cat: 'edit', name: 'Redact', icon: 'redact', desc: 'Permanently remove sensitive text and images', kw: 'blackout censor hide remove privacy', route: 'edit?mode=redact', isNew: true },
  { id: 'watermark', cat: 'edit', name: 'Watermark', icon: 'droplet', desc: 'Stamp text or a logo across pages', kw: 'stamp draft confidential logo' },
  { id: 'pagenum', cat: 'edit', name: 'Page numbers', icon: 'hash', desc: 'Number pages with your own format and position', kw: 'numbering footer header bates' },

  { id: 'merge', cat: 'organize', name: 'Merge PDF', icon: 'merge', desc: 'Combine PDFs into one, in the order you want', kw: 'combine join append concatenate' },
  { id: 'split', cat: 'organize', name: 'Split PDF', icon: 'scissors', desc: 'Extract pages or split into several files', kw: 'extract separate pages ranges' },
  { id: 'organize', cat: 'organize', name: 'Organize pages', icon: 'grid', desc: 'Reorder, rotate, delete, duplicate and insert pages', kw: 'reorder sort move delete insert blank arrange' },
  { id: 'crop', cat: 'organize', name: 'Crop PDF', icon: 'crop', desc: 'Trim margins or cut pages down to the part you need', kw: 'trim margins cut resize page size whitespace', isNew: true },
  { id: 'rotate', cat: 'organize', name: 'Rotate PDF', icon: 'rotate', desc: 'Turn all or some pages the right way up', kw: 'turn orientation landscape portrait' },

  { id: 'img2pdf', cat: 'convert', name: 'Images to PDF', icon: 'image', desc: 'JPG, PNG, WebP or GIF images into one PDF', kw: 'jpg jpeg png photo scan convert' },
  { id: 'pdf2img', cat: 'convert', name: 'PDF to images', icon: 'download', desc: 'Every page as a PNG or JPG image', kw: 'png jpg jpeg export convert render' },
  { id: 'pdftext', cat: 'convert', name: 'PDF to text', icon: 'filetext', desc: 'Copy out all the text, in reading order', kw: 'txt extract copy words' },
  { id: 'extract', cat: 'convert', name: 'Extract images', icon: 'layers', desc: 'Save the pictures embedded in a PDF', kw: 'pictures photos embedded' },

  { id: 'compress', cat: 'secure', name: 'Compress PDF', icon: 'shrink', desc: 'Make files smaller for email and upload', kw: 'reduce size shrink optimize smaller' },
  { id: 'protect', cat: 'secure', name: 'Protect PDF', icon: 'lock', desc: 'Encrypt with AES-256 and set permissions', kw: 'password encrypt secure lock' },
  { id: 'unlock', cat: 'secure', name: 'Unlock PDF', icon: 'unlock', desc: 'Remove a password you know', kw: 'decrypt remove password open' },
  { id: 'metadata', cat: 'secure', name: 'Metadata & privacy', icon: 'eraser', desc: 'See, edit or wipe author, dates and hidden data', kw: 'scrub author title properties exif privacy info' },
]

export const byId = (id) => CATALOG.find((t) => t.id === id)

/** Good next steps after a tool, for the result card's "Continue with…" chips. */
export const NEXT = {
  merge: ['compress', 'pagenum', 'protect', 'edit'],
  split: ['merge', 'compress'],
  organize: ['compress', 'pagenum', 'edit'],
  rotate: ['compress', 'edit'],
  crop: ['compress', 'edit'],
  edit: ['compress', 'protect', 'merge'],
  studio: ['img2pdf', 'compress'],
  watermark: ['protect', 'compress'],
  pagenum: ['protect', 'compress'],
  img2pdf: ['compress', 'edit', 'merge'],
  compress: ['protect', 'merge'],
  protect: [],
  unlock: ['edit', 'compress'],
  metadata: ['compress', 'protect'],
}

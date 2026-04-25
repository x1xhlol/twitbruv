// Minimal store-only (uncompressed) ZIP archive builder for the data-export
// endpoint. We avoid pulling in a dependency for two reasons:
//   1. The /api/me/export response is already gzipped at the HTTP layer for
//      callers that send Accept-Encoding: gzip — store mode keeps the encoder
//      tiny without sacrificing wire size in practice.
//   2. Bun's runtime has crc32 + DEFLATE available, but using only the bits
//      we need keeps this side-effect-free and easy to audit.
//
// The format produced is a single-disk ZIP (PKZIP appnote v6.3.4):
//   For each file:
//     - 30-byte LFH (local file header) + filename + raw bytes
//   Then:
//     - one CDH (central directory header) per file + filename
//     - 22-byte EOCD (end of central directory) record
//
// We always set the local "version needed to extract" to 2.0, the deflate
// flag is left clear (compression method 0 = stored), and the timestamps
// default to a constant DOS time so byte-for-byte output is reproducible.

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Uint8Array
  crc: number
  offset: number
}

const TEXT = new TextEncoder()
const DOS_DATE = 0x21 // 1980-01-01
const DOS_TIME = 0x00

function writeUInt16LE(view: DataView, offset: number, val: number) {
  view.setUint16(offset, val, true)
}
function writeUInt32LE(view: DataView, offset: number, val: number) {
  view.setUint32(offset, val, true)
}

export function buildZip(files: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const entries: Array<ZipEntry> = []
  const localChunks: Array<Uint8Array> = []
  let runningOffset = 0

  for (const f of files) {
    const nameBytes = TEXT.encode(f.name)
    const data = typeof f.data === 'string' ? TEXT.encode(f.data) : f.data
    const crc = crc32(data)
    const lfh = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(lfh.buffer)
    writeUInt32LE(view, 0, 0x04034b50) // local file header signature
    writeUInt16LE(view, 4, 20) // version needed
    writeUInt16LE(view, 6, 0) // flags
    writeUInt16LE(view, 8, 0) // compression method (stored)
    writeUInt16LE(view, 10, DOS_TIME)
    writeUInt16LE(view, 12, DOS_DATE)
    writeUInt32LE(view, 14, crc)
    writeUInt32LE(view, 18, data.length) // compressed size
    writeUInt32LE(view, 22, data.length) // uncompressed size
    writeUInt16LE(view, 26, nameBytes.length)
    writeUInt16LE(view, 28, 0) // extra field length
    lfh.set(nameBytes, 30)
    localChunks.push(lfh, data)
    entries.push({ name: f.name, data, crc, offset: runningOffset })
    runningOffset += lfh.length + data.length
  }

  // Central directory.
  const cdChunks: Array<Uint8Array> = []
  for (const e of entries) {
    const nameBytes = TEXT.encode(e.name)
    const cdh = new Uint8Array(46 + nameBytes.length)
    const view = new DataView(cdh.buffer)
    writeUInt32LE(view, 0, 0x02014b50) // central file header signature
    writeUInt16LE(view, 4, 20) // version made by
    writeUInt16LE(view, 6, 20) // version needed
    writeUInt16LE(view, 8, 0) // flags
    writeUInt16LE(view, 10, 0) // method (stored)
    writeUInt16LE(view, 12, DOS_TIME)
    writeUInt16LE(view, 14, DOS_DATE)
    writeUInt32LE(view, 16, e.crc)
    writeUInt32LE(view, 20, e.data.length) // compressed
    writeUInt32LE(view, 24, e.data.length) // uncompressed
    writeUInt16LE(view, 28, nameBytes.length)
    writeUInt16LE(view, 30, 0) // extra
    writeUInt16LE(view, 32, 0) // comment
    writeUInt16LE(view, 34, 0) // disk number start
    writeUInt16LE(view, 36, 0) // internal attrs
    writeUInt32LE(view, 38, 0) // external attrs
    writeUInt32LE(view, 42, e.offset)
    cdh.set(nameBytes, 46)
    cdChunks.push(cdh)
  }
  const cdSize = cdChunks.reduce((a, b) => a + b.length, 0)
  const cdOffset = runningOffset

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  writeUInt32LE(eocdView, 0, 0x06054b50)
  writeUInt16LE(eocdView, 4, 0)
  writeUInt16LE(eocdView, 6, 0)
  writeUInt16LE(eocdView, 8, entries.length)
  writeUInt16LE(eocdView, 10, entries.length)
  writeUInt32LE(eocdView, 12, cdSize)
  writeUInt32LE(eocdView, 16, cdOffset)
  writeUInt16LE(eocdView, 20, 0) // comment length

  const totalSize =
    runningOffset + cdSize + eocd.length
  const out = new Uint8Array(totalSize)
  let pos = 0
  for (const chunk of localChunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  for (const chunk of cdChunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  out.set(eocd, pos)
  return out
}

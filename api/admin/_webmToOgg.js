// Remuxes a WebM file containing a single Opus audio track (exactly what
// Chrome's MediaRecorder produces for a voice note) into an Ogg Opus file,
// per RFC 7845 — WITHOUT re-encoding. WebM and Ogg are both just container
// formats; the compressed Opus audio data inside is identical either way,
// so this only needs to extract the raw Opus packets from WebM's EBML
// structure and re-wrap them in Ogg pages. No external service, no audio
// quality loss, no network round-trip.
//
// Scoped deliberately to what Chrome's MediaRecorder actually outputs
// (single audio track, codec A_OPUS, unknown-size Segment, simple/
// unlaced blocks in the common case) rather than being a general EBML
// parser — see parseWebmOpus()'s comments for the parts that are
// best-effort rather than fully spec-general.

// ── EBML VINT reading ───────────────────────────────────────────────────
// Element IDs keep their marker bit as part of the numeric id (that's the
// conventional way Matroska IDs like 0x18538067 are written/compared).
// Element sizes strip the marker bit to get the numeric value; a size
// whose data bits are ALL 1 means "unknown size" (common for a Segment
// that was never seeked-back-to to patch in a real size).
function readVintId(buf, pos) {
  const first = buf[pos];
  if (first === undefined) throw new Error('Unexpected end of buffer reading EBML id');
  let length = 1;
  for (let mask = 0x80; mask > 0 && !(first & mask); mask >>= 1) length++;
  if (length > 4) throw new Error('Invalid EBML id length');
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + buf[pos + i];
  return { id: value, length };
}

function readVintSize(buf, pos) {
  const first = buf[pos];
  if (first === undefined) throw new Error('Unexpected end of buffer reading EBML size');
  let length = 1, mask = 0x80;
  while (mask > 0 && !(first & mask)) { mask >>= 1; length++; }
  if (mask === 0 || length > 8) throw new Error('Invalid EBML size VINT');
  const firstDataBits = first & (mask - 1);
  let isUnknown = firstDataBits === (mask - 1);
  let value = firstDataBits;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i];
    if (b !== 0xff) isUnknown = false;
    value = value * 256 + b;
  }
  return { size: isUnknown ? -1 : value, length };
}

// EBML lacing's per-frame size deltas are a VINT with the usual value bias
// (subtract 2^(7*length-1) - 1) to allow negative deltas. MediaRecorder
// doesn't use lacing in practice, so this path is defensive, not critical.
function readVintSigned(buf, pos) {
  const r = readVintSize(buf, pos);
  const bias = Math.pow(2, 7 * r.length - 1) - 1;
  return { value: r.size - bias, length: r.length };
}

const ID_INFO = 0x1549a966;
const ID_SEGMENT = 0x18538067;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;
const ID_BLOCK_GROUP = 0xa0;

function readUint(buf, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

function parseWebmOpus(buf) {
  let opusHead = null;
  let audioTrackNumber = null;
  let timestampScale = 1000000; // default: 1 tick = 1,000,000ns = 1ms
  const packets = []; // { ticks, data } — ticks is in timestampScale units

  function collectBlock(start, end, clusterBaseTicks) {
    let p = start;
    const trackVint = readVintSize(buf, p); // track number is itself a size-style VINT
    p += trackVint.length;
    if (trackVint.size !== audioTrackNumber) return; // Tracks always precedes Clusters, so this is already known

    const rel16 = (buf[p] << 8) | buf[p + 1];
    const relTicks = rel16 >= 0x8000 ? rel16 - 0x10000 : rel16;
    p += 2;
    const flags = buf[p]; p += 1;
    const lacing = (flags >> 1) & 0x3;
    const ticks = clusterBaseTicks + relTicks;

    if (lacing === 0) {
      packets.push({ ticks, data: buf.slice(p, end) });
      return;
    }
    const frameCount = buf[p] + 1; p += 1;
    const sizes = [];
    if (lacing === 2) { // fixed-size
      const each = Math.floor((end - p) / frameCount);
      for (let i = 0; i < frameCount; i++) sizes.push(each);
    } else if (lacing === 1) { // Xiph
      for (let i = 0; i < frameCount - 1; i++) {
        let size = 0, b;
        do { b = buf[p]; p += 1; size += b; } while (b === 255);
        sizes.push(size);
      }
      sizes.push(end - p - sizes.reduce((a, b) => a + b, 0));
    } else { // EBML lacing
      const first = readVintSize(buf, p); p += first.length;
      sizes.push(first.size);
      let prev = first.size;
      for (let i = 1; i < frameCount - 1; i++) {
        const sv = readVintSigned(buf, p); p += sv.length;
        prev += sv.value;
        sizes.push(prev);
      }
      sizes.push(end - p - sizes.reduce((a, b) => a + b, 0));
    }
    let off = p;
    for (const sz of sizes) { packets.push({ ticks, data: buf.slice(off, off + sz) }); off += sz; }
  }

  function walk(start, end, clusterBaseTicks) {
    let p = start;
    let localClusterBase = clusterBaseTicks;
    while (p < end) {
      const idInfo = readVintId(buf, p); p += idInfo.length;
      const sizeInfo = readVintSize(buf, p); p += sizeInfo.length;
      const elemStart = p;
      const elemEnd = sizeInfo.size === -1 ? end : Math.min(p + sizeInfo.size, end);

      switch (idInfo.id) {
        case ID_SEGMENT:
        case ID_INFO:
        case ID_TRACKS:
          walk(elemStart, elemEnd, null);
          break;
        case ID_TIMESTAMP_SCALE:
          timestampScale = readUint(buf, elemStart, elemEnd);
          break;
        case ID_TRACK_ENTRY: {
          let tp = elemStart, tNum = null, tType = null, codecId = null, codecPriv = null;
          while (tp < elemEnd) {
            const tid = readVintId(buf, tp); tp += tid.length;
            const tsz = readVintSize(buf, tp); tp += tsz.length;
            const tEnd = tp + tsz.size;
            if (tid.id === ID_TRACK_NUMBER) tNum = readUint(buf, tp, tEnd);
            else if (tid.id === ID_TRACK_TYPE) tType = readUint(buf, tp, tEnd);
            else if (tid.id === ID_CODEC_ID) codecId = Buffer.from(buf.slice(tp, tEnd)).toString('ascii');
            else if (tid.id === ID_CODEC_PRIVATE) codecPriv = buf.slice(tp, tEnd);
            tp = tEnd;
          }
          if (tType === 2 && codecId === 'A_OPUS' && codecPriv) { audioTrackNumber = tNum; opusHead = codecPriv; }
          break;
        }
        case ID_CLUSTER:
          walk(elemStart, elemEnd, 0);
          break;
        case ID_CLUSTER_TIMESTAMP:
          localClusterBase = readUint(buf, elemStart, elemEnd);
          break;
        case ID_SIMPLE_BLOCK:
        case ID_BLOCK:
          collectBlock(elemStart, elemEnd, localClusterBase);
          break;
        case ID_BLOCK_GROUP:
          walk(elemStart, elemEnd, localClusterBase);
          break;
        default:
          break; // Segment, EBML header, and anything else we don't need — just skip over
      }
      p = elemEnd;
    }
  }

  walk(0, buf.length, null);
  if (!opusHead) throw new Error('No Opus audio track found in this WebM file');
  return { opusHead, timestampScale, packets };
}

// ── Ogg page writing ────────────────────────────────────────────────────
// Ogg's CRC-32 is NOT the common zlib/PNG variant — different polynomial,
// no reflection, no final XOR. Getting this wrong produces a file most
// players silently reject.
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff];
  return crc >>> 0;
}

function buildOggPage({ packetData, granulePosition, serialNumber, pageSequence, headerType }) {
  const segments = [];
  let remaining = packetData.length;
  while (remaining >= 255) { segments.push(255); remaining -= 255; }
  segments.push(remaining); // terminates the packet even when remaining is 0

  const headerLen = 27 + segments.length;
  const page = Buffer.alloc(headerLen + packetData.length);
  page.write('OggS', 0, 'ascii');
  page.writeUInt8(0, 4); // stream structure version
  page.writeUInt8(headerType, 5);
  page.writeBigUInt64LE(BigInt(Math.max(0, Math.round(granulePosition))), 6);
  page.writeUInt32LE(serialNumber, 14);
  page.writeUInt32LE(pageSequence, 18);
  page.writeUInt32LE(0, 22); // checksum placeholder, filled in below
  page.writeUInt8(segments.length, 26);
  for (let i = 0; i < segments.length; i++) page.writeUInt8(segments[i], 27 + i);
  packetData.copy(page, headerLen);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

function remuxOpusWebmToOgg(webmBuffer) {
  const { opusHead, timestampScale, packets } = parseWebmOpus(webmBuffer);
  const serialNumber = Math.floor(Math.random() * 0xfffffffe) + 1;
  const pages = [];
  let seq = 0;

  pages.push(buildOggPage({ packetData: opusHead, granulePosition: 0, serialNumber, pageSequence: seq++, headerType: 0x02 })); // BOS
  const vendor = Buffer.from('sada-h2o-remux', 'ascii');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(vendor.length, 0);
  const zeroCommentsBuf = Buffer.alloc(4); // 0 user comments
  const tags = Buffer.concat([Buffer.from('OpusTags', 'ascii'), lenBuf, vendor, zeroCommentsBuf]);
  pages.push(buildOggPage({ packetData: tags, granulePosition: 0, serialNumber, pageSequence: seq++, headerType: 0 }));

  packets.forEach((pkt, i) => {
    const granule = (pkt.ticks * timestampScale / 1e9) * 48000; // Opus's granule domain is always 48kHz
    pages.push(buildOggPage({
      packetData: pkt.data,
      granulePosition: granule,
      serialNumber,
      pageSequence: seq++,
      headerType: i === packets.length - 1 ? 0x04 : 0 // EOS on the last page
    }));
  });

  return Buffer.concat(pages);
}

module.exports = { remuxOpusWebmToOgg };

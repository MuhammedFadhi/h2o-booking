/* SA'DA H2O — PDF/A-3b builder for ZATCA invoices.
   ---------------------------------------------------------------------------
   Turns page images (JPEG, one per A4 page) into a PDF/A-3b file and embeds the
   ZATCA UBL XML as an associated file (AFRelationship = Alternative), the same
   layout Al Amanah produces with mPDF. Used by the invoice page's "PDF/A-3"
   button; runs in the browser (window.PDFLib) and in Node for testing.

   PDF/A-3b needs, besides the content:
     - XMP metadata (pdfaid:part 3, conformance B) matching the Info dictionary;
     - an sRGB OutputIntent (the ICC profile is generated below, no download);
     - a trailer /ID, no encryption, no JavaScript, no transparency;
     - embedded files with a MIME /Subtype, /Params /ModDate and an
       /AFRelationship, listed in the catalog's /AF array (pdf-lib does that).
   The page content is the rendered invoice image, so no fonts are involved and
   Arabic shows exactly as on screen.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SADAPdfA3 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- minimal ICC v2 sRGB display profile --------------------------------
  function s15(v) { return Math.round(v * 65536) | 0; }
  function makeSrgbIcc() {
    const ascii = (str) => Array.from(str).map(c => c.charCodeAt(0));
    const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const xyz = (x, y, z) => [...ascii('XYZ '), 0, 0, 0, 0, ...u32(s15(x) >>> 0), ...u32(s15(y) >>> 0), ...u32(s15(z) >>> 0)];
    const pad4 = (a) => { while (a.length % 4) a.push(0); return a; };

    const descText = 'sRGB IEC61966-2.1';
    const desc = [...ascii('desc'), 0, 0, 0, 0, ...u32(descText.length + 1), ...ascii(descText), 0,
      ...u32(0), ...u32(0),                // Unicode language code + count
      0, 0, 0,                             // ScriptCode code + count
      ...new Array(67).fill(0)];
    const cprt = [...ascii('text'), 0, 0, 0, 0, ...ascii('No copyright, use freely'), 0];
    // sRGB transfer curve as gamma 2.2 (u8Fixed8 0x0233).
    const curv = [...ascii('curv'), 0, 0, 0, 0, ...u32(1), 0x02, 0x33];

    const tags = [
      ['desc', desc],
      ['cprt', cprt],
      ['wtpt', xyz(0.9642, 1.0, 0.8249)],
      ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
      ['gXYZ', xyz(0.3851, 0.7169, 0.0971)],
      ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
      ['rTRC', curv], ['gTRC', curv], ['bTRC', curv],
    ];
    const tableSize = 4 + tags.length * 12;
    let offset = 128 + tableSize;
    const table = [...u32(tags.length)];
    const data = [];
    const placed = new Map();              // identical curves share one block
    for (const [sig, bytes] of tags) {
      let at = placed.get(bytes);
      if (at === undefined) {
        at = offset;
        const block = pad4(bytes.slice());
        data.push(...block);
        offset += block.length;
        placed.set(bytes, at);
      }
      table.push(...ascii(sig), ...u32(at), ...u32(bytes.length));
    }
    const size = 128 + tableSize + data.length;
    const header = [
      ...u32(size), 0, 0, 0, 0,                        // size, preferred CMM
      0x02, 0x10, 0, 0,                                // version 2.1
      ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
      0x07, 0xE6, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0,        // 2022-01-01 00:00:00
      ...ascii('acsp'), 0, 0, 0, 0,                    // signature, platform
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,              // flags, manufacturer, model
      0, 0, 0, 0, 0, 0, 0, 0,                          // attributes
      0, 0, 0, 0,                                      // rendering intent: perceptual
      ...u32(s15(0.9642)), ...u32(s15(1.0)), ...u32(s15(0.8249)),  // PCS illuminant D50
      0, 0, 0, 0,                                      // creator
      ...new Array(16).fill(0),                        // profile ID
      ...new Array(28).fill(0),                        // reserved
    ];
    return new Uint8Array([...header, ...table, ...data]);
  }

  // ---- XMP -----------------------------------------------------------------
  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isoNoMs(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  function xmp(m) {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(m.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(m.author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(m.subject)}</rdf:li></rdf:Alt></dc:description>
   <xmp:CreatorTool>${xmlEsc(m.creator)}</xmp:CreatorTool>
   <xmp:CreateDate>${isoNoMs(m.date)}</xmp:CreateDate>
   <xmp:ModifyDate>${isoNoMs(m.date)}</xmp:ModifyDate>
   <xmp:MetadataDate>${isoNoMs(m.date)}</xmp:MetadataDate>
   <pdf:Producer>${xmlEsc(m.producer)}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  }

  function randomHex(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.toUpperCase();
  }

  /**
   * build(PDFLib, opts) -> Promise<Uint8Array>
   * opts: {
   *   pages: [Uint8Array JPEG, ...]     one image per A4 page (no alpha);
   *   xml?: Uint8Array|string           ZATCA UBL XML to embed;
   *   xmlName?: string                  e.g. 'INV-2026-000005.xml';
   *   title, author, subject, creator   document metadata;
   *   date?: Date                       creation date (default now)
   * }
   */
  async function build(PDFLib, opts) {
    const { PDFDocument, PDFName, PDFHexString, AFRelationship } = PDFLib;
    const date = new Date(Math.floor((opts.date ? opts.date.getTime() : Date.now()) / 1000) * 1000);
    const meta = {
      title: opts.title || 'Tax Invoice', author: opts.author || "SA'DA H2O",
      subject: opts.subject || 'ZATCA tax invoice (PDF/A-3b, UBL XML embedded)',
      creator: opts.creator || "SA'DA H2O Booking", producer: "SA'DA H2O PDF/A-3 (pdf-lib)", date,
    };

    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.setTitle(meta.title, { showInWindow: true });
    doc.setAuthor(meta.author);
    doc.setSubject(meta.subject);
    doc.setCreator(meta.creator);
    doc.setProducer(meta.producer);
    doc.setCreationDate(date);
    doc.setModificationDate(date);

    // Pages: each image fills an A4 page (595.28 x 841.89 pt), keeping its ratio.
    const W = 595.28, H = 841.89;
    for (const jpg of opts.pages) {
      const img = await doc.embedJpg(jpg);
      const page = doc.addPage([W, H]);
      const scale = Math.min(W / img.width, H / img.height);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: (W - w) / 2, y: H - h, width: w, height: h });
    }

    // Associated file: the ZATCA XML (pdf-lib adds it to /Names and the catalog /AF).
    if (opts.xml) {
      const bytes = typeof opts.xml === 'string' ? new TextEncoder().encode(opts.xml) : opts.xml;
      await doc.attach(bytes, opts.xmlName || 'invoice.xml', {
        mimeType: 'text/xml',
        description: 'ZATCA e-invoice (UBL XML)',
        creationDate: date, modificationDate: date,
        afRelationship: AFRelationship.Alternative,
      });
    }

    const ctx = doc.context;
    // XMP metadata (uncompressed, as PDF/A requires it readable).
    const xmpBytes = new TextEncoder().encode(xmp(meta));
    const metaRef = ctx.register(ctx.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML', Length: xmpBytes.length }));
    doc.catalog.set(PDFName.of('Metadata'), metaRef);

    // sRGB output intent.
    const icc = makeSrgbIcc();
    const iccRef = ctx.register(ctx.flateStream(icc, { N: 3 }));
    const intent = ctx.obj({
      Type: 'OutputIntent', S: 'GTS_PDFA1',
      OutputConditionIdentifier: PDFLib.PDFString.of('sRGB IEC61966-2.1'),
      Info: PDFLib.PDFString.of('sRGB IEC61966-2.1'),
      RegistryName: PDFLib.PDFString.of('http://www.color.org'),
      DestOutputProfile: iccRef,
    });
    doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));

    // File identifier (required by PDF/A).
    const id = PDFHexString.of(randomHex(32));
    ctx.trailerInfo.ID = ctx.obj([id, id]);

    return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  }

  return { build, makeSrgbIcc };
});

/* SA'DA H2O — City name normaliser.
   Customers and staff type city names inconsistently ("khobar", "AL KHOBAR",
   "Al-Khobar", "Dmm"). This maps any spelling to one canonical city so analytics
   and filters group correctly.

   Design notes:
   - Canonical names match the `cities` table exactly, so normalised values stay
     compatible with the region/city dropdowns.
   - Distinct localities are NOT merged (Fanateer stays Fanateer, not Jubail) —
     only spelling/casing/prefix variants collapse. Merging real places would
     silently lose location detail.
   - Unknown values are Title-Cased and returned as-is rather than discarded, so
     nothing disappears from reports.
*/
(function (global) {

  // Canonical city list (mirrors the `cities` table).
  var CANONICAL = [
    'Abqaiq', 'Al Ahsa', 'Al Khobar', 'Anak', 'Aziziyah', 'Bandariyah',
    'Dammam', 'Dhahran', 'Fanateer', 'Hafar Al-Batin', 'Hofuf', 'Jeddah',
    'Jubail', 'Jubail Industrial', 'Julmodah', 'Mubarraz', 'Qatif', 'Rakah',
    'Ras Tanura', 'Riyadh', 'Safwa', 'Saihat', 'Tarout', 'Thuqbah'
  ];

  // Explicit aliases → canonical. Keys are already "keyed" (see keyOf).
  var ALIASES = {
    khobar: 'Al Khobar', alkhobar: 'Al Khobar', khubar: 'Al Khobar',
    kobar: 'Al Khobar', khobr: 'Al Khobar', kh: 'Al Khobar',
    dammam: 'Dammam', damam: 'Dammam', dmm: 'Dammam', dammm: 'Dammam',
    daman: 'Dammam', dammamcity: 'Dammam',
    jubail: 'Jubail', jubayl: 'Jubail', jubial: 'Jubail', jubali: 'Jubail',
    jubailindustrial: 'Jubail Industrial', jubailind: 'Jubail Industrial',
    dhahran: 'Dhahran', dahran: 'Dhahran', zahran: 'Dhahran',
    qatif: 'Qatif', katif: 'Qatif', qateef: 'Qatif',
    rakah: 'Rakah', raka: 'Rakah', rakkah: 'Rakah',
    thuqbah: 'Thuqbah', thugbah: 'Thuqbah', thoqbah: 'Thuqbah',
    riyadh: 'Riyadh', riyad: 'Riyadh', ryadh: 'Riyadh',
    hofuf: 'Hofuf', hufuf: 'Hofuf', ahsa: 'Al Ahsa', alahsa: 'Al Ahsa',
    hasa: 'Al Ahsa', mubarraz: 'Mubarraz', mubaraz: 'Mubarraz',
    hafaralbatin: 'Hafar Al-Batin', hafar: 'Hafar Al-Batin',
    rastanura: 'Ras Tanura', rastanurah: 'Ras Tanura',
    safwa: 'Safwa', saihat: 'Saihat', sayhat: 'Saihat',
    tarout: 'Tarout', taroot: 'Tarout', anak: 'Anak',
    aziziyah: 'Aziziyah', azizia: 'Aziziyah',
    bandariyah: 'Bandariyah', bandaria: 'Bandariyah',
    fanateer: 'Fanateer', fanatir: 'Fanateer',
    julmodah: 'Julmodah', jalmudah: 'Julmodah',
    abqaiq: 'Abqaiq', buqayq: 'Abqaiq', jeddah: 'Jeddah', jedah: 'Jeddah'
  };

  // Reduce a name to a comparison key: lowercase, strip Arabic article prefixes
  // (al/ad/ar/el), drop anything that isn't a letter or digit.
  function keyOf(s) {
    if (s == null) return '';
    var t = String(s).toLowerCase().trim();
    t = t.replace(/[\u0640\u064B-\u065F]/g, '');       // Arabic tatweel/diacritics
    t = t.replace(/^(al|ad|ar|as|el)[\s\-']+/g, '');   // leading article
    t = t.replace(/[\s\-'_.]+/g, '');                  // separators
    t = t.replace(/[^a-z0-9\u0600-\u06FF]/g, '');      // keep latin+arabic+digits
    return t;
  }

  // Pre-index the canonical list by key.
  var CANON_BY_KEY = {};
  CANONICAL.forEach(function (c) { CANON_BY_KEY[keyOf(c)] = c; });

  function titleCase(s) {
    return String(s).toLowerCase().replace(/\S+/g, function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).replace(/\s+/g, ' ').trim();
  }

  /* Map any input to its canonical city name.
     Returns '' for blank input. Unknown names come back Title-Cased. */
  function canonicalCity(input) {
    if (input == null) return '';
    var raw = String(input).trim();
    if (!raw) return '';
    var k = keyOf(raw);
    if (!k) return '';
    if (CANON_BY_KEY[k]) return CANON_BY_KEY[k];   // exact (after keying)
    if (ALIASES[k]) return ALIASES[k];             // known alias
    // Prefix/contains match against canonical keys, longest first, so
    // "khobarcity" or "dammam ksa" still resolve.
    var keys = Object.keys(CANON_BY_KEY).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      var ck = keys[i];
      if (ck.length >= 4 && (k.indexOf(ck) === 0 || k.indexOf(ck) > -1)) return CANON_BY_KEY[ck];
    }
    var akeys = Object.keys(ALIASES).sort(function (a, b) { return b.length - a.length; });
    for (var j = 0; j < akeys.length; j++) {
      var ak = akeys[j];
      if (ak.length >= 4 && k.indexOf(ak) > -1) return ALIASES[ak];
    }
    return titleCase(raw);   // unknown — keep it, just tidied
  }

  /* Group an array of rows by canonical city.
     rows: array, field: property holding the city string.
     Returns { 'Al Khobar': 12, ... } */
  function groupByCity(rows, field) {
    var out = {};
    (rows || []).forEach(function (r) {
      var c = canonicalCity(r && r[field]);
      if (!c) return;
      out[c] = (out[c] || 0) + 1;
    });
    return out;
  }

  global.SADACity = {
    canonicalCity: canonicalCity,
    groupByCity: groupByCity,
    CANONICAL: CANONICAL
  };
})(window);

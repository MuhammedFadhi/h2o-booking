// Brand spelling for SMS: "H₂O" only when it does NOT cost an extra SMS.
//
// Plain SMS (GSM-7) fit 160 characters (153 per part when split). One special
// character such as "₂" switches the whole message to Unicode, which fits only
// 70 (67 per part). So each message is sent with H₂O if that keeps the same
// number of parts, otherwise with H2O. Used by every file that sends SMS.

// Characters a plain SMS can carry ([ ] { } \ ~ ^ | € count as two).
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';

function smsParts(text) {
  const chars = [...String(text)];
  if (chars.every(c => GSM.includes(c) || GSM_EXT.includes(c))) {
    const len = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
    return len <= 160 ? 1 : Math.ceil(len / 153);
  }
  return chars.length <= 70 ? 1 : Math.ceil(chars.length / 67);
}

function smsText(body) {
  const text = String(body == null ? '' : body);
  const fancy = text.replace(/H2O/g, 'H₂O');
  const plain = fancy.replace(/H₂O/g, 'H2O');
  return smsParts(fancy) <= smsParts(plain) ? fancy : plain;
}

module.exports = { smsText, smsParts };

// Normalisasi nomor WA agar selalu berformat internasional (+62...)
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).trim().replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) {
    return p;
  }
  if (p.startsWith('62')) {
    return '+' + p;
  }
  if (p.startsWith('0')) {
    return '+62' + p.slice(1);
  }
  return '+62' + p;
}

module.exports = { normalizePhone };

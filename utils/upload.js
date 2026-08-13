// Flutter http mengirim application/octet-stream untuk upload walau file gambar,
// jadi terima image/* ATAU ekstensi gambar. Mencegah upload non-gambar.
function imageFileFilter(req, file, cb) {
  const isImageMime = file.mimetype && file.mimetype.startsWith('image/');
  const isImageExt = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.originalname || '');
  if (isImageMime || isImageExt) {
    cb(null, true);
  } else {
    cb(new Error('Hanya file gambar yang diizinkan (JPG, PNG, WebP, GIF, dll).'));
  }
}

module.exports = { imageFileFilter };

const { createClient } = require('@supabase/supabase-js');
const path = require('path');

let supabase = null;

function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak diatur di environment');
    }
    supabase = createClient(url, key, {
      auth: { persistSession: false }
    });
  }
  return supabase;
}

const BUCKET = process.env.SUPABASE_BUCKET || 'lapak';

/**
 * Upload buffer gambar ke Supabase Storage.
 * @param {Buffer} buffer - Isi file (req.file.buffer / req.files[i].buffer)
 * @param {string} folder - 'users' | 'stores' | 'products'
 * @param {string} originalName - Nama file asli (untuk ekstensi)
 * @param {string} [idPrefix] - Prefix unik (user_id / product_id)
 * @returns {Promise<string>} URL publik permanen
 */
async function uploadImage(buffer, folder, originalName, idPrefix = '') {
  const ext = (path.extname(originalName || '') || '.jpg').toLowerCase();
  const fileName = `${idPrefix}${idPrefix ? '_' : ''}${Date.now()}${ext}`;
  const filePath = `${folder}/${fileName}`;

  // Mime dari ekstensi (jpeg/jpg -> image/jpeg)
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const contentType = mimeMap[ext] || 'image/' + ext.replace('.', '');

  const { error } = await getSupabase()
    .storage
    .from(BUCKET)
    .upload(filePath, buffer, {
      contentType,
      upsert: false
    });

  if (error) {
    throw new Error(`Upload gagal ke Supabase: ${error.message}`);
  }

  return publicUrl(filePath);
}

/**
 * Hapus file dari bucket (untuk ganti avatar / hapus produk).
 * @param {string} url - URL publik atau path (folder/nama.ext)
 */
async function deleteImage(url) {
  if (!url) return;
  // Ambil path setelah /object/public/<bucket>/
  const marker = `/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  const filePath = idx !== -1 ? url.substring(idx + marker.length) : url;
  if (!filePath) return;

  const { error } = await getSupabase().storage.from(BUCKET).remove([filePath]);
  if (error && error.statusCode !== 404) {
    console.error('Delete Supabase file error:', error.message, filePath);
  }
}

/**
 * Bangun URL publik dari path folder/nama.ext.
 */
function publicUrl(filePath) {
  return getSupabase().storage.from(BUCKET).getPublicUrl(filePath).data.publicUrl;
}

module.exports = { uploadImage, deleteImage, publicUrl, getSupabase };
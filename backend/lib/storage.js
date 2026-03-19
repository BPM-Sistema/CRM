/**
 * Storage abstraction layer.
 * Supports both Supabase Storage and Google Cloud Storage.
 *
 * Set GCS_BUCKET env var to use Google Cloud Storage.
 * Otherwise falls back to Supabase Storage.
 */

const GCS_BUCKET = process.env.GCS_BUCKET;

let gcsClient = null;
let supabaseClient = null;

function getGCS() {
  if (!gcsClient) {
    const { Storage } = require('@google-cloud/storage');
    gcsClient = new Storage();
  }
  return gcsClient;
}

function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = require('../supabase');
  }
  return supabaseClient;
}

/**
 * Upload a file buffer to storage.
 * @param {string} path - Storage path (e.g. 'pendientes/1234-file.jpg')
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type
 * @returns {string} Public URL of the uploaded file
 */
async function uploadFile(path, buffer, contentType) {
  if (GCS_BUCKET) {
    const bucket = getGCS().bucket(GCS_BUCKET);
    const file = bucket.file(path);
    await file.save(buffer, {
      contentType,
      resumable: false,
      metadata: { cacheControl: 'public, max-age=31536000' }
    });
    return `https://storage.googleapis.com/${GCS_BUCKET}/${path}`;
  }

  // Fallback: Supabase Storage
  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from('comprobantes')
    .upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`Storage upload error: ${error.message}`);
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
}

/**
 * Get public URL for a file path.
 * @param {string} path - Storage path
 * @returns {string} Public URL
 */
function getPublicUrl(path) {
  if (GCS_BUCKET) {
    return `https://storage.googleapis.com/${GCS_BUCKET}/${path}`;
  }
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/comprobantes/${path}`;
}

/**
 * Health check - verify storage is accessible.
 * @returns {boolean}
 */
async function healthCheck() {
  if (GCS_BUCKET) {
    const bucket = getGCS().bucket(GCS_BUCKET);
    const [files] = await bucket.getFiles({ maxResults: 1 });
    return true;
  }

  const supabase = getSupabase();
  const { error } = await supabase.storage.from('comprobantes').list('', { limit: 1 });
  if (error) throw error;
  return true;
}

module.exports = { uploadFile, getPublicUrl, healthCheck };

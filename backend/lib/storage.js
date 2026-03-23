/**
 * Storage abstraction layer — Google Cloud Storage.
 */

const GCS_BUCKET = process.env.GCS_BUCKET;

if (!GCS_BUCKET) {
  console.error('[Storage] GCS_BUCKET env var is required');
}

let gcsClient = null;

function getGCS() {
  if (!gcsClient) {
    const { Storage } = require('@google-cloud/storage');
    gcsClient = new Storage();
  }
  return gcsClient;
}

/**
 * Upload a file buffer to storage.
 * @param {string} path - Storage path (e.g. 'pendientes/1234-file.jpg')
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type
 * @returns {string} Public URL of the uploaded file
 */
async function uploadFile(path, buffer, contentType) {
  const bucket = getGCS().bucket(GCS_BUCKET);
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000' }
  });
  return `https://storage.googleapis.com/${GCS_BUCKET}/${path}`;
}

/**
 * Get public URL for a file path.
 * @param {string} path - Storage path
 * @returns {string} Public URL
 */
function getPublicUrl(path) {
  return `https://storage.googleapis.com/${GCS_BUCKET}/${path}`;
}

/**
 * Health check - verify storage is accessible.
 * @returns {boolean}
 */
async function healthCheck() {
  const bucket = getGCS().bucket(GCS_BUCKET);
  await bucket.getFiles({ maxResults: 1 });
  return true;
}

module.exports = { uploadFile, getPublicUrl, healthCheck };

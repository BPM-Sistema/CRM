const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else if (!process.env.GCS_BUCKET) {
  // Only throw if GCS is also not configured — need at least one storage backend
  console.warn('[Supabase] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set. Storage requires GCS_BUCKET.');
}

module.exports = supabase;

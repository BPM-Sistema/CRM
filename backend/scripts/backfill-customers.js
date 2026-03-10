require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = require('../db');
const { normalizePhone } = require('../utils/phoneNormalize');

async function backfillCustomers() {
  const client = await pool.connect();
  try {
    console.log('Fetching distinct customers from orders_validated...');

    const { rows } = await client.query(`
      SELECT DISTINCT ON (COALESCE(customer_email, customer_phone))
        customer_name as name,
        customer_email as email,
        customer_phone as phone
      FROM orders_validated
      WHERE customer_phone IS NOT NULL OR customer_email IS NOT NULL
      ORDER BY COALESCE(customer_email, customer_phone), created_at DESC
    `);

    console.log(`Found ${rows.length} unique customers to process.`);

    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const { name, email, phone } = rows[i];
      const normalized_phone = phone ? normalizePhone(phone) : null;

      try {
        const result = await client.query(
          `INSERT INTO customers (name, email, phone, normalized_phone)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (normalized_phone) DO NOTHING`,
          [name || null, email || null, phone || null, normalized_phone]
        );

        if (result.rowCount > 0 && email) {
          // Check if we also need to skip on email conflict
          // The first insert succeeded based on normalized_phone,
          // but if there's a separate unique constraint on email, this is already handled by DO NOTHING
        }

        if (result.rowCount > 0) {
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        // Handle email unique constraint violation separately
        if (err.code === '23505') {
          skipped++;
        } else {
          console.error(`Error inserting customer ${email || phone}:`, err.message);
        }
      }

      if ((i + 1) % 100 === 0) {
        console.log(`Progress: ${i + 1}/${rows.length} processed (${inserted} inserted, ${skipped} skipped)`);
      }
    }

    console.log(`\nBackfill complete.`);
    console.log(`  Total processed: ${rows.length}`);
    console.log(`  Inserted: ${inserted}`);
    console.log(`  Skipped (already existed): ${skipped}`);
  } finally {
    client.release();
  }
}

backfillCustomers()
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });

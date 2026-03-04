require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

async function test() {
  try {
    // Obtener datos de transferencia de financiera default
    const finResult = await pool.query(`
      SELECT datos_transferencia
      FROM financieras
      WHERE is_default = true
      LIMIT 1
    `);
    
    const datosTransferencia = finResult.rows[0]?.datos_transferencia || '(sin datos configurados)';
    console.log('📋 Datos transferencia:', datosTransferencia);

    const telefono = '5491123945965';
    
    console.log('📤 Enviando plantilla pedido_creado a:', telefono);
    
    const response = await axios.post(
      'https://api.botmaker.com/v2.0/chats-actions/trigger-intent',
      {
        chat: {
          channelId: process.env.BOTMAKER_CHANNEL_ID,
          contactId: telefono
        },
        intentIdOrName: 'pedido_creado',
        variables: {
          '1': 'Netanel (Test)',
          '2': '99999',
          '3': datosTransferencia
        }
      },
      {
        headers: {
          'access-token': process.env.BOTMAKER_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Respuesta:', JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
  } finally {
    await pool.end();
  }
}

test();

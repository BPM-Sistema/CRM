/**
 * Script para enviar mensaje de reemplazo de producto a clientes específicos
 *
 * USO:
 *   node scripts/send-replacement-message.js --dry-run   # Ver qué se enviaría
 *   node scripts/send-replacement-message.js --send      # Enviar de verdad
 */

require('dotenv').config();
const axios = require('axios');

const PEDIDOS = [
  '30588', '30424', '30398', '30368', '30244',
  '30218', '30322', '30254', '30323', '30222'
];

const MENSAJE_TEMPLATE = (orderNumber) =>
  `¡Hola! ¿Cómo estás? Te escribimos de Blanqueria x mayor por tu pedido #${orderNumber} necesitamos realizar un reemplazo por un producto faltante, porfavor contesta este mensaje para coordinar`;

const TN_API_BASE = `https://api.tiendanube.com/v1/${process.env.TIENDANUBE_STORE_ID}`;
const TN_HEADERS = {
  'Authentication': `bearer ${process.env.TIENDANUBE_ACCESS_TOKEN}`,
  'User-Agent': 'BPM Administrador (netanel@example.com)',
  'Content-Type': 'application/json'
};

async function getOrderFromTN(orderNumber) {
  try {
    // Buscar por número de pedido
    const response = await axios.get(`${TN_API_BASE}/orders`, {
      headers: TN_HEADERS,
      params: { q: orderNumber }
    });

    const order = response.data.find(o => String(o.number) === String(orderNumber));
    if (!order) {
      return { error: `Pedido #${orderNumber} no encontrado en TN` };
    }

    const phone = order.customer?.phone || order.contact_phone;
    if (!phone) {
      return { error: `Pedido #${orderNumber} sin teléfono` };
    }

    return {
      orderNumber,
      tnOrderId: order.id,
      customerName: order.customer?.name || 'Sin nombre',
      phone: normalizePhone(phone),
      rawPhone: phone
    };
  } catch (err) {
    return { error: `Error obteniendo #${orderNumber}: ${err.message}` };
  }
}

function normalizePhone(phone) {
  // Limpiar y normalizar a formato 549XXXXXXXXXX
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');

  // Si empieza con +, quitar
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);

  // Si empieza con 0, quitar (número local argentino)
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);

  // Ahora normalizar
  if (cleaned.startsWith('549')) {
    return cleaned;
  } else if (cleaned.startsWith('54') && !cleaned.startsWith('549')) {
    // 54 sin 9 -> agregar 9
    return '549' + cleaned.substring(2);
  } else if (cleaned.startsWith('15')) {
    // 15XXXXXXXX -> 54911XXXXXXXX (asume CABA/GBA)
    return '5491' + cleaned;
  } else if (cleaned.length === 10 && cleaned.startsWith('11')) {
    // 11XXXXXXXX -> 54911XXXXXXXX
    return '549' + cleaned;
  } else if (cleaned.length === 10) {
    // Otro código de área, ej 351XXXXXXX -> 549351XXXXXXX
    return '549' + cleaned;
  }

  return cleaned;
}

async function sendMessageBotmaker(phone, message) {
  const accessToken = process.env.BOTMAKER_ACCESS_TOKEN;
  // Número de WhatsApp del negocio (extraído del BOTMAKER_CHANNEL_ID)
  const businessNumber = '5491136914124';

  const response = await axios.post(
    'https://api.botmaker.com/api/v1.0/message/v3',
    {
      chatPlatform: 'whatsapp',
      chatChannelNumber: businessNumber,
      platformContactId: phone,
      messageText: message
    },
    {
      headers: {
        'access-token': accessToken,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

async function main() {
  const mode = process.argv[2];

  if (!mode || (mode !== '--dry-run' && mode !== '--send')) {
    console.log('USO:');
    console.log('  node scripts/send-replacement-message.js --dry-run   # Ver qué se enviaría');
    console.log('  node scripts/send-replacement-message.js --send      # Enviar de verdad');
    process.exit(1);
  }

  const isDryRun = mode === '--dry-run';

  console.log('\n========================================');
  console.log(isDryRun ? '🔍 MODO DRY-RUN (no se enviará nada)' : '📤 MODO ENVÍO REAL');
  console.log('========================================\n');

  console.log('Obteniendo datos de Tiendanube...\n');

  const results = [];

  for (const orderNumber of PEDIDOS) {
    const data = await getOrderFromTN(orderNumber);
    results.push(data);

    if (data.error) {
      console.log(`❌ ${data.error}`);
    } else {
      console.log(`✅ #${data.orderNumber} - ${data.customerName}`);
      console.log(`   Tel: ${data.rawPhone} → ${data.phone}`);
    }
  }

  const valid = results.filter(r => !r.error);
  const invalid = results.filter(r => r.error);

  console.log('\n========================================');
  console.log(`📊 RESUMEN: ${valid.length} válidos, ${invalid.length} con errores`);
  console.log('========================================\n');

  if (valid.length === 0) {
    console.log('No hay pedidos válidos para enviar.');
    process.exit(1);
  }

  console.log('MENSAJES A ENVIAR:\n');
  for (const r of valid) {
    const mensaje = MENSAJE_TEMPLATE(r.orderNumber);
    console.log(`📱 ${r.phone} (${r.customerName})`);
    console.log(`   Pedido: #${r.orderNumber}`);
    console.log(`   Mensaje: "${mensaje}"`);
    console.log('');
  }

  if (isDryRun) {
    console.log('========================================');
    console.log('🔍 Dry run completado. Para enviar de verdad:');
    console.log('   node scripts/send-replacement-message.js --send');
    console.log('========================================');
    process.exit(0);
  }

  // Envío real
  console.log('========================================');
  console.log('📤 ENVIANDO MENSAJES...');
  console.log('========================================\n');

  for (const r of valid) {
    const mensaje = MENSAJE_TEMPLATE(r.orderNumber);
    try {
      const result = await sendMessageBotmaker(r.phone, mensaje);
      console.log(`✅ #${r.orderNumber} enviado a ${r.phone}`);
      console.log(`   Response: ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`❌ #${r.orderNumber} FALLÓ: ${err.response?.data?.message || err.message}`);
      if (err.response?.data) {
        console.log(`   Response: ${JSON.stringify(err.response.data)}`);
      }
    }

    // Pequeña pausa entre envíos
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n✅ Proceso completado');
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});

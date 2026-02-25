/**
 * Tests para POST /validate-order
 *
 * Este endpoint valida pedidos contra TiendaNube e inserta en orders_validated.
 * Es crítico porque /upload depende de monto_tiendanube para calcular estado_cuenta.
 */

// ============================================
// MOCKS - Deben ir ANTES de require del app
// ============================================

// Mock de variables de entorno
process.env.PORT = '3998'; // Puerto diferente para evitar conflictos
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_KEY = 'test-key';
process.env.TIENDANUBE_ACCESS_TOKEN = 'test-token';
process.env.TIENDANUBE_STORE_ID = '12345';
process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.SENTRY_DSN = '';

// Mock de pg (PostgreSQL)
const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery,
  connect: jest.fn().mockResolvedValue({
    query: mockQuery,
    release: jest.fn()
  }),
  on: jest.fn(),
  end: jest.fn()
};
jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPool)
}));

// Mock de Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://test.url' } })
      }))
    }
  }))
}));

// Mock de Google Vision
jest.mock('@google-cloud/vision', () => ({
  ImageAnnotatorClient: jest.fn().mockImplementation(() => ({
    textDetection: jest.fn().mockResolvedValue([{ textAnnotations: [] }])
  }))
}));

// Mock de axios (TiendaNube API)
const mockAxios = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  create: jest.fn().mockReturnThis(),
  defaults: { headers: { common: {} } }
};
jest.mock('axios', () => mockAxios);

// Mock de Sentry
jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  setupExpressErrorHandler: jest.fn(),
  captureException: jest.fn()
}));

// Mock de sharp
jest.mock('sharp', () => {
  return jest.fn().mockImplementation(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake')),
    metadata: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
    composite: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue({})
  }));
});

// ============================================
// IMPORTS
// ============================================

const request = require('supertest');

// ============================================
// CONSTANTES
// ============================================

const SERVER_URL = 'http://localhost:3998';

// Respuesta mock de TiendaNube
const MOCK_TIENDANUBE_ORDER = {
  id: 12345,
  number: 12345,
  total: '75000.50',  // Monto específico para verificar
  payment_status: 'pending',
  currency: 'ARS',
  customer: {
    id: 1,
    name: 'Juan Pérez',
    email: 'juan@test.com',
    phone: '+5491155551234'
  },
  contact_name: 'Juan Pérez',
  contact_email: 'juan@test.com',
  contact_phone: '+5491155551234',
  shipping_address: {
    phone: '+5491155551234'
  },
  created_at: '2025-01-15T10:30:00+0000'
};

// ============================================
// SETUP
// ============================================

// Array para trackear queries ejecutadas
let executedQueries = [];

function setupDefaultMocks() {
  jest.clearAllMocks();
  executedQueries = [];

  // PostgreSQL - trackear queries
  mockQuery.mockImplementation((query, params) => {
    executedQueries.push({ query, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });

  // Axios (TiendaNube) - pedido válido por defecto
  mockAxios.get.mockImplementation((url) => {
    if (url.includes('/orders')) {
      return Promise.resolve({
        data: [MOCK_TIENDANUBE_ORDER]
      });
    }
    return Promise.resolve({ data: [] });
  });
}

// ============================================
// TESTS
// ============================================

describe('POST /validate-order', () => {
  beforeAll((done) => {
    setupDefaultMocks();
    require('../index');
    setTimeout(done, 1000);
  });

  afterAll((done) => {
    setTimeout(done, 500);
  });

  beforeEach(() => {
    setupDefaultMocks();
  });

  // ----------------------------------------
  // TEST 1: orderNumber válido
  // ----------------------------------------
  describe('orderNumber válido', () => {
    it('debería responder 200 con datos correctos', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.orderNumber).toBe('12345');
    });

    it('debería incluir monto_tiendanube en la respuesta', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('monto_tiendanube');
      expect(response.body).toHaveProperty('currency');
    });
  });

  // ----------------------------------------
  // TEST 2: orderNumber inexistente en TiendaNube
  // ----------------------------------------
  describe('orderNumber inexistente', () => {
    it('debería responder 404 cuando TiendaNube no encuentra el pedido', async () => {
      // Mock TiendaNube devuelve array vacío
      mockAxios.get.mockResolvedValueOnce({ data: [] });

      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '99999999' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });

    it('debería responder 404 cuando TiendaNube devuelve 404', async () => {
      // Mock TiendaNube error 404
      mockAxios.get.mockRejectedValueOnce({
        response: { status: 404, data: { message: 'Not found' } },
        message: '404'
      });

      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '88888888' });

      expect(response.status).toBe(404);
    });
  });

  // ----------------------------------------
  // TEST 3: orderNumber ya existente (UPSERT)
  // ----------------------------------------
  describe('orderNumber ya existente', () => {
    it('debería responder 200 sin error (UPSERT maneja duplicados)', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  // ----------------------------------------
  // TEST 4: Falta orderNumber
  // ----------------------------------------
  describe('Falta orderNumber', () => {
    it('debería responder 400 con mensaje de error', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/orderNumber/i);
    });

    it('debería responder 400 cuando orderNumber es vacío', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '' });

      expect(response.status).toBe(400);
    });
  });

  // ----------------------------------------
  // TEST 5: Error de TiendaNube API (500)
  // ----------------------------------------
  describe('Error de TiendaNube API', () => {
    it('debería responder 500 sin crashear cuando TiendaNube falla', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('Internal Server Error'));

      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ----------------------------------------
  // TEST 6: Error de red
  // ----------------------------------------
  describe('Error de red', () => {
    it('debería manejar errores de conexión sin crashear', async () => {
      mockAxios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ----------------------------------------
  // TEST 7: Response es JSON válido
  // ----------------------------------------
  describe('Estructura de response', () => {
    it('debería devolver Content-Type application/json', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('debería devolver objeto JSON válido', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(typeof response.body).toBe('object');
      expect(response.body).not.toBeNull();
    });
  });

  // ----------------------------------------
  // TEST 8: Verificar que se ejecuta UPSERT (ON CONFLICT)
  // ----------------------------------------
  describe('Verificación de UPSERT', () => {
    it('debería ejecutar query con ON CONFLICT para evitar duplicados', async () => {
      await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      // Buscar query que contenga ON CONFLICT
      const upsertQuery = executedQueries.find(q =>
        q.query.toLowerCase().includes('on conflict')
      );

      expect(upsertQuery).toBeDefined();
      expect(upsertQuery.query.toLowerCase()).toContain('insert into orders_validated');
      expect(upsertQuery.query.toLowerCase()).toContain('on conflict');
    });

    it('debería incluir order_number en los parámetros del UPSERT', async () => {
      await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      const upsertQuery = executedQueries.find(q =>
        q.query.toLowerCase().includes('on conflict')
      );

      expect(upsertQuery).toBeDefined();
      expect(upsertQuery.params).toContain('12345');
    });
  });

  // ----------------------------------------
  // TEST 9: Verificar monto_tiendanube correcto
  // ----------------------------------------
  describe('Verificación de monto_tiendanube', () => {
    it('debería devolver el monto exacto de TiendaNube en la respuesta', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(200);
      // MOCK_TIENDANUBE_ORDER.total = '75000.50'
      expect(response.body.monto_tiendanube).toBe(75000.5);
    });

    it('debería guardar el monto correcto en la base de datos', async () => {
      await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      // Buscar query de insert
      const insertQuery = executedQueries.find(q =>
        q.query.toLowerCase().includes('insert into orders_validated')
      );

      expect(insertQuery).toBeDefined();
      // El monto (75000.5) debería estar en los parámetros
      // Verificar que algún parámetro es el monto
      const montoEnParams = insertQuery.params.some(p =>
        p === 75000.5 || p === 75000 || p === '75000.50'
      );
      expect(montoEnParams).toBe(true);
    });

    it('debería devolver currency correcta', async () => {
      const response = await request(SERVER_URL)
        .post('/validate-order')
        .send({ orderNumber: '12345' });

      expect(response.status).toBe(200);
      expect(response.body.currency).toBe('ARS');
    });
  });
});

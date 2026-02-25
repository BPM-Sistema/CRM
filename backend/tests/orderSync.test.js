/**
 * Tests para el sistema de sincronización de pedidos
 *
 * Este sistema es crítico porque:
 * - Inserta y actualiza pedidos desde TiendaNube
 * - Maneja la cola de sincronización
 * - Debe ser resiliente a errores y race conditions
 */

// ============================================
// MOCKS - Deben ir ANTES de require
// ============================================

// Mock de variables de entorno
process.env.TIENDANUBE_STORE_ID = '12345';
process.env.TIENDANUBE_ACCESS_TOKEN = 'test-token';

// Mock de axios (TiendaNube API)
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  get: mockAxiosGet
}));

// Mock de pg (PostgreSQL) - via ../db
const mockQuery = jest.fn();
jest.mock('../db', () => ({
  query: mockQuery
}));

// Mock de syncQueue
const mockGetNextPending = jest.fn();
const mockMarkCompleted = jest.fn();
const mockMarkFailed = jest.fn();
const mockAddToQueue = jest.fn();
const mockUpdateSyncState = jest.fn();
const mockCleanupOldItems = jest.fn();

jest.mock('../services/syncQueue', () => ({
  getNextPending: mockGetNextPending,
  markCompleted: mockMarkCompleted,
  markFailed: mockMarkFailed,
  addToQueue: mockAddToQueue,
  getSyncState: jest.fn(),
  updateSyncState: mockUpdateSyncState,
  cleanupOldItems: mockCleanupOldItems
}));

// ============================================
// IMPORTS (después de mocks)
// ============================================

const { processQueue } = require('../services/orderSync');

// ============================================
// DATOS DE PRUEBA
// ============================================

const MOCK_TIENDANUBE_ORDER = {
  id: 98765,
  number: 12345,
  total: '75000.50',
  currency: 'ARS',
  payment_status: 'pending',
  created_at: '2026-01-15T10:30:00+0000',
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
  products: [
    {
      product_id: 101,
      variant_id: 201,
      name: 'Alimento Premium',
      variant_values: ['10kg', 'Adulto'],
      quantity: 2,
      price: '25000.00',
      sku: 'ALI-PREM-10'
    },
    {
      product_id: 102,
      variant_id: null,
      name: 'Juguete Perro',
      variant_values: null,
      quantity: 1,
      price: '25000.50',
      sku: 'JUG-001'
    }
  ]
};

const MOCK_QUEUE_ITEM = {
  id: 'queue-item-123',
  type: 'order_created',
  resource_id: '98765',
  order_number: '12345',
  payload: {
    orderId: 98765,
    orderNumber: '12345'
  },
  status: 'processing',
  attempts: 1
};

// ============================================
// HELPERS
// ============================================

function setupDefaultMocks() {
  jest.clearAllMocks();

  // TiendaNube API - pedido válido
  mockAxiosGet.mockResolvedValue({
    data: MOCK_TIENDANUBE_ORDER
  });

  // PostgreSQL - queries exitosas
  mockQuery.mockImplementation((query) => {
    const q = query.toLowerCase();

    // INSERT orders_validated
    if (q.includes('insert into orders_validated')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // SELECT order_products (para detectar productos a eliminar)
    if (q.includes('select') && q.includes('order_products')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // INSERT order_products
    if (q.includes('insert into order_products')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // DELETE order_products
    if (q.includes('delete from order_products')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // SELECT orders_validated (para processOrderPaid)
    if (q.includes('select') && q.includes('orders_validated')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // INSERT pagos_efectivo
    if (q.includes('insert into pagos_efectivo')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // INSERT logs
    if (q.includes('insert into logs')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // UPDATE orders_validated
    if (q.includes('update orders_validated')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // Default
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  // Queue - item pendiente por defecto
  mockGetNextPending.mockResolvedValue({ ...MOCK_QUEUE_ITEM });
  mockMarkCompleted.mockResolvedValue();
  mockMarkFailed.mockResolvedValue();
}

// ============================================
// TESTS
// ============================================

describe('Order Sync Worker (processQueue)', () => {
  beforeEach(() => {
    setupDefaultMocks();
  });

  // ----------------------------------------
  // CASO 1: Pedido nuevo
  // ----------------------------------------
  describe('Caso 1: Pedido nuevo', () => {
    it('debería insertar pedido en orders_validated', async () => {
      const result = await processQueue();

      expect(result.success).toBe(true);

      // Verificar INSERT en orders_validated
      const insertOrderCall = mockQuery.mock.calls.find(call =>
        call[0].toLowerCase().includes('insert into orders_validated')
      );

      expect(insertOrderCall).toBeDefined();
      expect(insertOrderCall[1]).toContain('12345'); // order_number
    });

    it('debería insertar productos en order_products', async () => {
      const result = await processQueue();

      expect(result.success).toBe(true);

      // Verificar INSERTs en order_products (2 productos)
      const insertProductCalls = mockQuery.mock.calls.filter(call =>
        call[0].toLowerCase().includes('insert into order_products')
      );

      expect(insertProductCalls.length).toBe(2);
    });

    it('no debería crashear durante el proceso', async () => {
      await expect(processQueue()).resolves.not.toThrow();
    });
  });

  // ----------------------------------------
  // CASO 2: Pedido ya existente (UPSERT)
  // ----------------------------------------
  describe('Caso 2: Pedido ya existente', () => {
    it('debería usar ON CONFLICT para no duplicar pedido', async () => {
      await processQueue();

      // Verificar que la query usa ON CONFLICT
      const insertOrderCall = mockQuery.mock.calls.find(call =>
        call[0].toLowerCase().includes('insert into orders_validated')
      );

      expect(insertOrderCall).toBeDefined();
      expect(insertOrderCall[0].toLowerCase()).toContain('on conflict');
    });

    it('debería usar ON CONFLICT para no duplicar productos', async () => {
      await processQueue();

      // Verificar que las queries de productos usan ON CONFLICT
      const insertProductCalls = mockQuery.mock.calls.filter(call =>
        call[0].toLowerCase().includes('insert into order_products')
      );

      expect(insertProductCalls.length).toBeGreaterThan(0);
      insertProductCalls.forEach(call => {
        expect(call[0].toLowerCase()).toContain('on conflict');
      });
    });
  });

  // ----------------------------------------
  // CASO 3: Pedido sin productos
  // ----------------------------------------
  describe('Caso 3: Pedido sin productos', () => {
    it('debería manejar pedido sin productos sin crashear', async () => {
      // Mock pedido sin productos
      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          products: []
        }
      });

      const result = await processQueue();

      expect(result.success).toBe(true);
    });

    it('debería insertar el pedido aunque no tenga productos', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          products: []
        }
      });

      await processQueue();

      const insertOrderCall = mockQuery.mock.calls.find(call =>
        call[0].toLowerCase().includes('insert into orders_validated')
      );

      expect(insertOrderCall).toBeDefined();
    });

    it('no debería intentar insertar productos si no hay', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          products: []
        }
      });

      await processQueue();

      const insertProductCalls = mockQuery.mock.calls.filter(call =>
        call[0].toLowerCase().includes('insert into order_products')
      );

      expect(insertProductCalls.length).toBe(0);
    });

    it('debería manejar products: undefined', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          products: undefined
        }
      });

      const result = await processQueue();

      expect(result.success).toBe(true);
    });
  });

  // ----------------------------------------
  // CASO 4: Error de DB simulado
  // ----------------------------------------
  describe('Caso 4: Error de DB simulado', () => {
    it('debería manejar error de INSERT sin crashear', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database connection lost'));

      const result = await processQueue();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database connection lost');
    });

    it('no debería crashear el worker con error de DB', async () => {
      mockQuery.mockRejectedValue(new Error('DB Error'));

      await expect(processQueue()).resolves.not.toThrow();
    });
  });

  // ----------------------------------------
  // CASO 5: Race condition simulada
  // ----------------------------------------
  describe('Caso 5: Race condition simulada', () => {
    it('debería procesar mismo pedido 2 veces sin duplicar (UPSERT)', async () => {
      // Primera ejecución
      await processQueue();

      // Resetear mock de cola para segunda ejecución
      mockGetNextPending.mockResolvedValue({ ...MOCK_QUEUE_ITEM, id: 'queue-item-456' });

      // Segunda ejecución con mismo pedido
      await processQueue();

      // Verificar que ambas usaron ON CONFLICT
      const insertOrderCalls = mockQuery.mock.calls.filter(call =>
        call[0].toLowerCase().includes('insert into orders_validated')
      );

      expect(insertOrderCalls.length).toBe(2);
      insertOrderCalls.forEach(call => {
        expect(call[0].toLowerCase()).toContain('on conflict');
      });
    });

    it('debería usar UPSERT para productos en race condition', async () => {
      // Primera ejecución
      await processQueue();

      mockGetNextPending.mockResolvedValue({ ...MOCK_QUEUE_ITEM, id: 'queue-item-789' });

      // Segunda ejecución
      await processQueue();

      const insertProductCalls = mockQuery.mock.calls.filter(call =>
        call[0].toLowerCase().includes('insert into order_products')
      );

      // 2 productos x 2 ejecuciones = 4 calls
      expect(insertProductCalls.length).toBe(4);
      insertProductCalls.forEach(call => {
        expect(call[0].toLowerCase()).toContain('on conflict');
      });
    });
  });

  // ----------------------------------------
  // CASO 6: markCompleted() se llama correctamente
  // ----------------------------------------
  describe('Caso 6: markCompleted() se llama correctamente', () => {
    it('debería llamar markCompleted exactamente una vez en éxito', async () => {
      await processQueue();

      expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    });

    it('debería llamar markCompleted con el ID correcto del item', async () => {
      await processQueue();

      expect(mockMarkCompleted).toHaveBeenCalledWith('queue-item-123');
    });

    it('no debería llamar markFailed cuando el proceso es exitoso', async () => {
      await processQueue();

      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------
  // CASO 7: markFailed() se llama correctamente en error
  // ----------------------------------------
  describe('Caso 7: markFailed() se llama correctamente en error', () => {
    it('debería llamar markFailed cuando pool.query falla', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await processQueue();

      expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    });

    it('debería llamar markFailed con el ID correcto y mensaje de error', async () => {
      const errorMessage = 'Database timeout';
      mockQuery.mockRejectedValueOnce(new Error(errorMessage));

      await processQueue();

      expect(mockMarkFailed).toHaveBeenCalledWith('queue-item-123', errorMessage);
    });

    it('no debería llamar markCompleted cuando hay error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB Error'));

      await processQueue();

      expect(mockMarkCompleted).not.toHaveBeenCalled();
    });

    it('debería llamar markFailed cuando TiendaNube API falla', async () => {
      mockAxiosGet.mockRejectedValueOnce(new Error('API timeout'));

      await processQueue();

      expect(mockMarkFailed).toHaveBeenCalledWith('queue-item-123', 'API timeout');
    });

    it('debería llamar markFailed cuando pedido no existe en TiendaNube', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: null });

      await processQueue();

      expect(mockMarkFailed).toHaveBeenCalled();
      expect(mockMarkFailed.mock.calls[0][0]).toBe('queue-item-123');
    });
  });

  // ----------------------------------------
  // CASO 8: Cola vacía
  // ----------------------------------------
  describe('Caso 8: Cola vacía (getNextPending retorna null)', () => {
    it('debería retornar null cuando no hay items pendientes', async () => {
      mockGetNextPending.mockResolvedValue(null);

      const result = await processQueue();

      expect(result).toBeNull();
    });

    it('no debería crashear con cola vacía', async () => {
      mockGetNextPending.mockResolvedValue(null);

      await expect(processQueue()).resolves.not.toThrow();
    });

    it('no debería llamar markCompleted con cola vacía', async () => {
      mockGetNextPending.mockResolvedValue(null);

      await processQueue();

      expect(mockMarkCompleted).not.toHaveBeenCalled();
    });

    it('no debería llamar markFailed con cola vacía', async () => {
      mockGetNextPending.mockResolvedValue(null);

      await processQueue();

      expect(mockMarkFailed).not.toHaveBeenCalled();
    });

    it('no debería llamar a TiendaNube API con cola vacía', async () => {
      mockGetNextPending.mockResolvedValue(null);

      await processQueue();

      expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('no debería ejecutar queries de DB con cola vacía', async () => {
      mockGetNextPending.mockResolvedValue(null);

      await processQueue();

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------
  // CASO ADICIONAL: order_paid
  // ----------------------------------------
  describe('Caso adicional: Procesamiento de order_paid', () => {
    it('debería procesar order_paid correctamente', async () => {
      mockGetNextPending.mockResolvedValue({
        ...MOCK_QUEUE_ITEM,
        type: 'order_paid'
      });

      // Mock pedido pagado
      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          payment_status: 'paid'
        }
      });

      const result = await processQueue();

      expect(result.success).toBe(true);
    });

    it('debería registrar el pago en pagos_efectivo', async () => {
      mockGetNextPending.mockResolvedValue({
        ...MOCK_QUEUE_ITEM,
        type: 'order_paid'
      });

      mockAxiosGet.mockResolvedValue({
        data: {
          ...MOCK_TIENDANUBE_ORDER,
          payment_status: 'paid'
        }
      });

      await processQueue();

      const insertPagoCall = mockQuery.mock.calls.find(call =>
        call[0].toLowerCase().includes('insert into pagos_efectivo')
      );

      expect(insertPagoCall).toBeDefined();
    });
  });

  // ----------------------------------------
  // CASO ADICIONAL: Tipo desconocido
  // ----------------------------------------
  describe('Caso adicional: Tipo de evento desconocido', () => {
    it('debería manejar tipo desconocido sin crashear', async () => {
      mockGetNextPending.mockResolvedValue({
        ...MOCK_QUEUE_ITEM,
        type: 'unknown_type'
      });

      const result = await processQueue();

      // Debería completar aunque no procese nada
      expect(result.success).toBe(true);
    });
  });

  // ----------------------------------------
  // CASO ADICIONAL: Estructura del resultado
  // ----------------------------------------
  describe('Estructura del resultado', () => {
    it('debería retornar objeto con success y item en éxito', async () => {
      const result = await processQueue();

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('item');
      expect(result.item.id).toBe('queue-item-123');
    });

    it('debería retornar objeto con success, item y error en fallo', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Test error'));

      const result = await processQueue();

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('item');
      expect(result).toHaveProperty('error', 'Test error');
    });
  });
});

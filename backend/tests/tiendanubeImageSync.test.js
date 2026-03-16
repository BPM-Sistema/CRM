/**
 * Tests para tiendanubeImageSync
 */

const fs = require('fs');
const path = require('path');

// Mock axios antes de importar
const mockAxiosGet = jest.fn();
const mockAxiosPut = jest.fn();
jest.mock('axios', () => ({
  get: mockAxiosGet,
  put: mockAxiosPut
}));

// Env vars de prueba
process.env.TIENDANUBE_STORE_ID = '99999';
process.env.TIENDANUBE_ACCESS_TOKEN = 'test-token-abc';

const {
  getVariantStock,
  findWinningVariant,
  computeNewImageOrder,
  syncProductImages,
  acquireLock,
  releaseLock,
  getLatestRun,
  getRunHistory,
  getRunDetail,
  ensureRuntimeDir,
  persistRunResult,
  RUNTIME_DIR,
  LOCK_FILE
} = require('../services/tiendanubeImageSync');

// Limpiar runtime dir antes/después de cada test
beforeEach(() => {
  jest.restoreAllMocks();
  mockAxiosGet.mockReset();
  mockAxiosPut.mockReset();
  mockAxiosPut.mockResolvedValue({ data: {} });
  // Limpiar archivos de runtime
  if (fs.existsSync(RUNTIME_DIR)) {
    const files = fs.readdirSync(RUNTIME_DIR);
    for (const f of files) {
      fs.unlinkSync(path.join(RUNTIME_DIR, f));
    }
  }
});

afterAll(() => {
  // Cleanup completo
  if (fs.existsSync(RUNTIME_DIR)) {
    const files = fs.readdirSync(RUNTIME_DIR);
    for (const f of files) {
      fs.unlinkSync(path.join(RUNTIME_DIR, f));
    }
    fs.rmdirSync(RUNTIME_DIR);
  }
});

// ─── getVariantStock ────────────────────────────────────────

describe('getVariantStock', () => {
  test('usa inventory_levels si existe', () => {
    const variant = { id: 1, stock: 5, inventory_levels: [{ stock: 10 }, { stock: 20 }] };
    expect(getVariantStock(variant)).toBe(30);
  });

  test('fallback a variant.stock si no hay inventory_levels', () => {
    expect(getVariantStock({ id: 1, stock: 15 })).toBe(15);
  });

  test('fallback a variant.stock si inventory_levels está vacío', () => {
    expect(getVariantStock({ id: 1, stock: 7, inventory_levels: [] })).toBe(7);
  });

  test('retorna 0 si no hay stock ni inventory_levels', () => {
    expect(getVariantStock({ id: 1 })).toBe(0);
  });

  test('maneja valores null en inventory_levels', () => {
    const variant = { id: 1, inventory_levels: [{ stock: null }, { stock: 5 }] };
    expect(getVariantStock(variant)).toBe(5);
  });
});

// ─── findWinningVariant ─────────────────────────────────────

describe('findWinningVariant', () => {
  test('producto sin variantes retorna null', () => {
    expect(findWinningVariant({ id: 1, variants: [], images: [{ id: 10, position: 1 }, { id: 20, position: 2 }] })).toBeNull();
  });

  test('producto sin variantes (undefined) retorna null', () => {
    expect(findWinningVariant({ id: 1, images: [{ id: 10, position: 1 }] })).toBeNull();
  });

  test('producto con 0 imágenes retorna null', () => {
    expect(findWinningVariant({ id: 1, variants: [{ id: 1, stock: 10, image_id: 10 }], images: [] })).toBeNull();
  });

  test('producto con 1 imagen retorna null', () => {
    expect(findWinningVariant({
      id: 1, variants: [{ id: 1, stock: 10, image_id: 10 }], images: [{ id: 10, position: 1 }]
    })).toBeNull();
  });

  test('elige variante con mayor stock', () => {
    const product = {
      id: 1,
      variants: [
        { id: 100, stock: 5, image_id: 10 },
        { id: 200, stock: 20, image_id: 20 },
        { id: 300, stock: 3, image_id: 30 }
      ],
      images: [{ id: 10, position: 1 }, { id: 20, position: 2 }, { id: 30, position: 3 }]
    };
    expect(findWinningVariant(product).id).toBe(200);
  });

  test('empate: prioriza variante con imagen actualmente primera', () => {
    const product = {
      id: 1,
      variants: [
        { id: 100, stock: 10, image_id: 10 },
        { id: 200, stock: 10, image_id: 20 }
      ],
      images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
    };
    expect(findWinningVariant(product).id).toBe(100);
  });

  test('empate: si ninguna tiene imagen primera, elige menor variant.id', () => {
    const product = {
      id: 1,
      variants: [
        { id: 300, stock: 10, image_id: 20 },
        { id: 100, stock: 10, image_id: 30 }
      ],
      images: [{ id: 10, position: 1 }, { id: 20, position: 2 }, { id: 30, position: 3 }]
    };
    expect(findWinningVariant(product).id).toBe(100);
  });

  test('empate: variante con imagen primera gana sobre menor id', () => {
    const product = {
      id: 1,
      variants: [
        { id: 50, stock: 10, image_id: 20 },
        { id: 200, stock: 10, image_id: 10 }
      ],
      images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
    };
    expect(findWinningVariant(product).id).toBe(200);
  });
});

// ─── computeNewImageOrder ───────────────────────────────────

describe('computeNewImageOrder', () => {
  test('reordena correctamente manteniendo orden relativo del resto', () => {
    const images = [
      { id: 8, position: 1 }, { id: 15, position: 2 },
      { id: 22, position: 3 }, { id: 30, position: 4 }
    ];
    expect(computeNewImageOrder(images, 22).map(i => i.id)).toEqual([22, 8, 15, 30]);
  });

  test('retorna null si imagen ganadora ya está primera', () => {
    expect(computeNewImageOrder([{ id: 8, position: 1 }, { id: 15, position: 2 }], 8)).toBeNull();
  });

  test('retorna null si image_id no existe en el array', () => {
    expect(computeNewImageOrder([{ id: 8, position: 1 }, { id: 15, position: 2 }], 999)).toBeNull();
  });

  test('funciona con 2 imágenes', () => {
    expect(computeNewImageOrder([{ id: 8, position: 1 }, { id: 15, position: 2 }], 15).map(i => i.id)).toEqual([15, 8]);
  });

  test('mueve última imagen a primera posición', () => {
    const images = [
      { id: 1, position: 1 }, { id: 2, position: 2 }, { id: 3, position: 3 },
      { id: 4, position: 4 }, { id: 5, position: 5 }
    ];
    expect(computeNewImageOrder(images, 5).map(i => i.id)).toEqual([5, 1, 2, 3, 4]);
  });
});

// ─── Lock anti-concurrencia ─────────────────────────────────

describe('lock', () => {
  test('acquireLock crea lock file', () => {
    const acquired = acquireLock('test');
    expect(acquired).toBe(true);
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
    releaseLock();
  });

  test('lock activo impide segunda ejecución', () => {
    const first = acquireLock('test1');
    const second = acquireLock('test2');
    expect(first).toBe(true);
    expect(second).toBe(false);
    releaseLock();
  });

  test('releaseLock elimina lock file', () => {
    acquireLock('test');
    releaseLock();
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  test('lock stale se recupera', () => {
    // Crear lock con timestamp viejo (20 min atrás)
    ensureRuntimeDir();
    const staleLock = {
      started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      pid: 99999,
      hostname: 'test',
      trigger_source: 'old'
    };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(staleLock), 'utf8');

    const acquired = acquireLock('recovery');
    expect(acquired).toBe(true);
    releaseLock();
  });
});

// ─── Persistencia ───────────────────────────────────────────

describe('persistencia', () => {
  test('persistRunResult genera latest.json', () => {
    const result = {
      run_id: 'test-run-1',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'success',
      dry_run: false,
      trigger_source: 'test',
      products_scanned: 5,
      products_changed: 1,
      products_skipped: 4,
      errors_count: 0,
      changed_products: [],
      errors: [],
      items: []
    };

    persistRunResult(result);

    const latest = getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest.run_id).toBe('test-run-1');
    expect(latest.status).toBe('success');
  });

  test('persistRunResult genera run-<id>.json', () => {
    const result = {
      run_id: 'test-run-2',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 200,
      status: 'partial',
      dry_run: false,
      trigger_source: 'test',
      products_scanned: 10,
      products_changed: 2,
      products_skipped: 7,
      errors_count: 1,
      changed_products: [{ product_id: 1, winning_variant_id: 2, winning_image_id: 3, previous_first_image_id: 4, reason: 'test' }],
      errors: [{ product_id: 5, message: 'err' }],
      items: [{ product_id: 1, changed: true, reason: 'test' }]
    };

    persistRunResult(result);

    const detail = getRunDetail('test-run-2');
    expect(detail).not.toBeNull();
    expect(detail.run_id).toBe('test-run-2');
    expect(detail.items).toHaveLength(1);
  });

  test('persistRunResult append a runs.jsonl', () => {
    for (let i = 0; i < 3; i++) {
      persistRunResult({
        run_id: `jsonl-${i}`,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: i * 100,
        status: 'success',
        dry_run: false,
        trigger_source: 'test',
        products_scanned: i,
        products_changed: 0,
        products_skipped: i,
        errors_count: 0,
        changed_products: [],
        errors: [],
        items: []
      });
    }

    const history = getRunHistory(10);
    expect(history).toHaveLength(3);
    // Más reciente primero
    expect(history[0].run_id).toBe('jsonl-2');
  });

  test('getLatestRun sin archivos devuelve null', () => {
    expect(getLatestRun()).toBeNull();
  });

  test('getRunHistory sin archivos devuelve array vacío', () => {
    expect(getRunHistory()).toEqual([]);
  });

  test('getRunDetail con id inexistente devuelve null', () => {
    expect(getRunDetail('inexistente')).toBeNull();
  });
});

// ─── syncProductImages (integración) ────────────────────────

describe('syncProductImages', () => {
  test('producto sin variantes: skip', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 1, variants: [], images: [{ id: 10, position: 1 }, { id: 20, position: 2 }] }
    });

    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result.products_scanned).toBe(1);
    expect(result.products_skipped).toBe(1);
    expect(result.products_changed).toBe(0);
    expect(result.status).toBe('success');
  });

  test('variante ganadora sin image_id: skip', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [{ id: 100, stock: 10, image_id: null }],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result.products_skipped).toBe(1);
    expect(result.items[0].reason).toBe('variante ganadora sin image_id');
  });

  test('imagen ganadora ya primera: skip', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [
          { id: 100, stock: 10, image_id: 10 },
          { id: 200, stock: 5, image_id: 20 }
        ],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result.products_skipped).toBe(1);
    expect(result.items[0].reason).toBe('imagen ganadora ya en posicion 1');
  });

  test('dry run detecta cambio sin aplicar', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [
          { id: 100, stock: 5, image_id: 10 },
          { id: 200, stock: 20, image_id: 20 }
        ],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result.products_changed).toBe(1);
    expect(result.changed_products).toHaveLength(1);
    expect(result.changed_products[0].product_id).toBe(1);
    expect(mockAxiosPut).not.toHaveBeenCalled();
  });

  test('aplica reorder cuando no es dry run', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [
          { id: 100, stock: 5, image_id: 10 },
          { id: 200, stock: 20, image_id: 20 }
        ],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '1', dryRun: false, triggerSource: 'test' });
    expect(result.products_changed).toBe(1);
    expect(result.status).toBe('success');
    expect(mockAxiosPut).toHaveBeenCalled();
  });

  test('error en un producto no corta el proceso', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          variants: [{ id: 100, stock: 10, image_id: 20 }],
          images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
        },
        {
          id: 2,
          variants: [{ id: 200, stock: 20, image_id: 30 }],
          images: [{ id: 20, position: 1 }, { id: 30, position: 2 }]
        }
      ]
    });

    mockAxiosPut
      .mockRejectedValueOnce({ response: { status: 400 }, message: 'API error' })
      .mockResolvedValue({ data: {} });

    const result = await syncProductImages({ dryRun: false, triggerSource: 'test' });
    expect(result.products_scanned).toBe(2);
    expect(result.errors_count).toBe(1);
    expect(result.products_changed).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.errors).toHaveLength(1);
  });

  test('paginación: procesa múltiples páginas', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, variants: [], images: [] }));
    const page2 = [{ id: 51, variants: [], images: [] }];

    mockAxiosGet
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await syncProductImages({ dryRun: true, triggerSource: 'test' });
    expect(result.products_scanned).toBe(51);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  test('image_id no encontrada en imágenes del producto: skip', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [{ id: 100, stock: 10, image_id: 999 }],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result.products_skipped).toBe(1);
    expect(result.items[0].reason).toBe('image_id no encontrada en imagenes del producto');
  });

  test('lock impide corrida concurrente y retorna null', async () => {
    // Adquirir lock manualmente
    acquireLock('blocking');

    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 1, variants: [], images: [] }
    });

    const result = await syncProductImages({ productId: '1', triggerSource: 'test' });
    expect(result).toBeNull();

    releaseLock();
  });

  test('persiste resultado en archivos después de corrida', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [
          { id: 100, stock: 5, image_id: 10 },
          { id: 200, stock: 20, image_id: 20 }
        ],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });

    const latest = getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest.products_changed).toBe(1);
    expect(latest.status).toBe('success');
    expect(latest.trigger_source).toBe('test');

    const history = getRunHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  test('si falla persistencia el sync no explota', async () => {
    // Hacer que writeFileSync falle solo en persistRunResult (no en lock)
    const originalWriteFileSync = fs.writeFileSync;
    let callCount = 0;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      callCount++;
      // Lock usa writeJsonAtomic (2 calls: tmp + rename). Dejar pasar las primeras 2 (lock).
      // Fallar a partir de la 3ra (persistRunResult -> latest.json tmp)
      if (callCount >= 3) throw new Error('disk full');
      return originalWriteFileSync.apply(fs, args);
    });
    // rename también es usado por writeJsonAtomic
    const originalRenameSync = fs.renameSync;
    let renameCount = 0;
    jest.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      renameCount++;
      if (renameCount >= 2) throw new Error('disk full');
      return originalRenameSync.apply(fs, args);
    });

    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 1, variants: [], images: [{ id: 10, position: 1 }, { id: 20, position: 2 }] }
    });

    // No debería explotar
    const result = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(result).not.toBeNull();
    expect(result.products_scanned).toBe(1);

    fs.writeFileSync.mockRestore();
    fs.renameSync.mockRestore();
  });

  test('lock activo forzado: segunda corrida retorna null y no modifica archivos', async () => {
    // Primera corrida exitosa
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 1,
        variants: [{ id: 100, stock: 20, image_id: 20 }],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });
    const first = await syncProductImages({ productId: '1', dryRun: true, triggerSource: 'test' });
    expect(first).not.toBeNull();
    expect(first.products_changed).toBe(1);

    const latestAfterFirst = getLatestRun();
    expect(latestAfterFirst.run_id).toBe(first.run_id);

    // Forzar lock activo (simular corrida en progreso)
    acquireLock('blocking-test');

    // Segunda corrida: debe retornar null
    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 2, variants: [{ id: 200, stock: 30, image_id: 30 }],
        images: [{ id: 30, position: 1 }, { id: 40, position: 2 }] }
    });
    const second = await syncProductImages({ productId: '2', dryRun: true, triggerSource: 'test' });
    expect(second).toBeNull();

    // latest.json sigue siendo de la primera corrida
    const latestAfterSecond = getLatestRun();
    expect(latestAfterSecond.run_id).toBe(first.run_id);
    expect(latestAfterSecond.products_changed).toBe(1);

    releaseLock();
  });

  test('datos persisten tras re-importar modulo (simula restart)', async () => {
    // Ejecutar una corrida que persista archivos
    mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: 42,
        variants: [
          { id: 100, stock: 5, image_id: 10 },
          { id: 200, stock: 50, image_id: 20 }
        ],
        images: [{ id: 10, position: 1 }, { id: 20, position: 2 }]
      }
    });

    const result = await syncProductImages({ productId: '42', dryRun: true, triggerSource: 'test' });
    expect(result.products_changed).toBe(1);
    const runId = result.run_id;

    // Simular restart: leer directamente desde archivos con fs
    // (no desde memoria del modulo, sino desde disco)
    const latestRaw = JSON.parse(fs.readFileSync(
      path.join(RUNTIME_DIR, 'latest.json'), 'utf8'
    ));
    expect(latestRaw.run_id).toBe(runId);
    expect(latestRaw.products_changed).toBe(1);
    expect(latestRaw.changed_products).toHaveLength(1);
    expect(latestRaw.changed_products[0].product_id).toBe(42);
    expect(latestRaw.trigger_source).toBe('test');

    // getLatestRun lee de disco, no de memoria
    const fromGetter = getLatestRun();
    expect(fromGetter.run_id).toBe(runId);

    // run detail también persiste
    const detail = getRunDetail(runId);
    expect(detail).not.toBeNull();
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].product_id).toBe(42);
    expect(detail.items[0].winning_image_id).toBe(20);

    // historial también persiste
    const history = getRunHistory();
    expect(history.some(r => r.run_id === runId)).toBe(true);
  });
});

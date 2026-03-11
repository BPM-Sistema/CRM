/**
 * Jest Configuration
 * Tests para el backend de PetLove
 */

// Set test environment for JWT_SECRET fallback
process.env.NODE_ENV = 'test';

module.exports = {
  // Entorno de Node.js
  testEnvironment: 'node',

  // Donde buscar tests
  testMatch: ['**/tests/**/*.test.js'],

  // Ignorar node_modules
  testPathIgnorePatterns: ['/node_modules/'],

  // Timeout por test (120 segundos para OCR real)
  testTimeout: 120000,

  // Verbose output
  verbose: true,

  // Limpiar mocks entre tests
  clearMocks: true,

  // No transformar nada (CommonJS puro)
  transform: {},
};

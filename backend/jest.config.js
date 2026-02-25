/**
 * Jest Configuration
 * Tests para el backend de PetLove
 */

module.exports = {
  // Entorno de Node.js
  testEnvironment: 'node',

  // Donde buscar tests
  testMatch: ['**/tests/**/*.test.js'],

  // Ignorar node_modules
  testPathIgnorePatterns: ['/node_modules/'],

  // Timeout por test (30 segundos)
  testTimeout: 30000,

  // Verbose output
  verbose: true,

  // Limpiar mocks entre tests
  clearMocks: true,

  // No transformar nada (CommonJS puro)
  transform: {},
};

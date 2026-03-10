const jwt = require('jsonwebtoken');

// Set env vars before requiring the module
process.env.WASPY_JWT_SECRET = 'test-secret-key';
process.env.WASPY_TENANT_ID = 'test-tenant-uuid';
process.env.WASPY_URL = 'http://localhost:4000';

const { generateWaspyToken } = require('../services/waspyClient');

describe('waspyClient', () => {
  describe('generateWaspyToken', () => {
    const mockUser = {
      id: 'user-123',
      name: 'Test User',
      email: 'test@example.com',
      role_name: 'admin'
    };

    it('generates a valid JWT', () => {
      const token = generateWaspyToken(mockUser);
      const decoded = jwt.verify(token, 'test-secret-key');
      expect(decoded.sub).toBe('user-123');
      expect(decoded.tenantId).toBe('test-tenant-uuid');
      expect(decoded.role).toBe('admin');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.name).toBe('Test User');
      expect(decoded.iss).toBe('crm');
      expect(decoded.aud).toBe('waspy');
    });

    it('maps operador role to agent', () => {
      const token = generateWaspyToken({ ...mockUser, role_name: 'operador' });
      const decoded = jwt.verify(token, 'test-secret-key');
      expect(decoded.role).toBe('agent');
    });

    it('maps caja role to agent', () => {
      const token = generateWaspyToken({ ...mockUser, role_name: 'caja' });
      const decoded = jwt.verify(token, 'test-secret-key');
      expect(decoded.role).toBe('agent');
    });

    it('maps logistica role to read_only', () => {
      const token = generateWaspyToken({ ...mockUser, role_name: 'logistica' });
      const decoded = jwt.verify(token, 'test-secret-key');
      expect(decoded.role).toBe('read_only');
    });

    it('maps unknown role to read_only', () => {
      const token = generateWaspyToken({ ...mockUser, role_name: 'something_else' });
      const decoded = jwt.verify(token, 'test-secret-key');
      expect(decoded.role).toBe('read_only');
    });
  });
});

const handler = require('../pages/api/products');
const httpMocks = require('node-mocks-http');

describe('/api/products', () => {
  test('returns 200 and an array of products', async () => {
    const req = httpMocks.createRequest({ method: 'GET' });
    const res = httpMocks.createResponse();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData ? res._getJSONData() : JSON.parse(res._getData());
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(typeof data[0]).toBe('object');
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
    }
  });
});

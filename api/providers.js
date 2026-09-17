const { getProviderStats } = require('../lib/llm-providers');
const { sendJson } = require('../lib/http');

module.exports = (req, res) => {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    sendJson(res, 200, getProviderStats());
  } catch (e) {
    console.error('/api/providers error:', e);
    sendJson(res, 500, { error: e.message });
  }
};

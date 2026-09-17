const { getMetrics } = require('../lib/database');
const { sendJson } = require('../lib/http');

module.exports = async (req, res) => {
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
    sendJson(res, 200, await getMetrics());
  } catch (e) {
    console.error('/api/metrics error:', e);
    sendJson(res, 500, { error: e.message });
  }
};

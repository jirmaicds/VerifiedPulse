require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { handleCheckClaim } = require('./lib/check-claim-handler');
const { getProviderStats } = require('./lib/llm-providers');
const { getMetrics } = require('./lib/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/check-claim', async (req, res) => {
  try {
    await handleCheckClaim(req, res);
  } catch (e) {
    console.error('/api/check-claim error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/providers', async (req, res) => {
  try {
    res.json(getProviderStats());
  } catch (e) {
    console.error('/api/providers error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/metrics', async (req, res) => {
  try {
    const data = await getMetrics();
    res.json(data);
  } catch (e) {
    console.error('/api/metrics error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`VerifiedPulse server running on http://localhost:${PORT}`);
});


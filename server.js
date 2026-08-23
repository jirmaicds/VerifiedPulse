require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { callLLM, getProviderStats } = require('./lib/llm-providers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const checks = [];

async function searchWeb(claim) {
  const apiKey = process.env.SEARCH_API_KEY;
  const maxResults = parseInt(process.env.SEARCH_MAX_RESULTS || '5', 10);

  if (apiKey) {
    const apiUrl = process.env.SEARCH_API_URL || 'https://api.tavily.com/search';
    const body = {
      query: claim,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: true
    };

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        console.error('Search API error:', res.status);
        return null;
      }

      return await res.json();
    } catch (e) {
      console.error('Search failed:', e.message);
      return null;
    }
  }

  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `q=${encodeURIComponent(claim)}`
    });

    if (!res.ok) return null;

    const html = await res.text();
    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g;
    let match;
    while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
      const url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      results.push({ title, url, content: '' });
    }

    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let sMatch;
    let idx = 0;
    while ((sMatch = snippetRegex.exec(html)) !== null && idx < results.length) {
      results[idx].content = sMatch[1].replace(/<[^>]+>/g, '').trim();
      idx++;
    }

    if (results.length > 0) {
      return { results };
    }

    return null;
  } catch (e) {
    console.error('DuckDuckGo search failed:', e.message);
    return null;
  }
}

app.post('/api/check-claim', async (req, res) => {
  try {
    const { claim } = req.body;
    if (!claim) return res.status(400).json({ error: 'Claim text is required' });

    let searchEvidence = null;
    try {
      searchEvidence = await searchWeb(claim);
    } catch (e) {
      console.error('Search step failed (continuing without search):', e.message);
    }

    const result = await callLLM(claim, searchEvidence, req.body.propositions);
    const conjunctionResult = !!result.conjunction_result;
    const provider = result.provider || 'heuristic';

    checks.push({
      claim,
      mode: 'text',
      propositions: JSON.stringify(result.propositions),
      conjunction_result: conjunctionResult ? 1 : 0,
      search_evidence: searchEvidence ? JSON.stringify(searchEvidence) : null,
      created_at: new Date().toISOString()
    });

    res.json({
      claim,
      mode: 'text',
      propositions: result.propositions,
      conjunction_result: conjunctionResult,
      search_evidence: searchEvidence,
      provider,
      warnings: result.warnings || [],
      rateLimitedProviders: result.rateLimitedProviders || []
    });
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
    const rows = checks.map(({ mode, conjunction_result, created_at }) => ({ mode, conjunction_result, created_at }));

    const total = rows.length;
    const verified = rows.filter(r => r.conjunction_result === 1).length;
    const flagged = rows.filter(r => r.conjunction_result === 0).length;

    const weeklyMap = new Map();
    const weeklyVerifiedMap = new Map();
    const byMode = {};
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      weeklyMap.set(key, 0);
      weeklyVerifiedMap.set(key, 0);
    }

    rows.forEach(r => {
      const date = r.created_at ? r.created_at.slice(0, 10) : null;
      if (r.mode) {
        byMode[r.mode] = byMode[r.mode] || { total: 0, verified: 0, flagged: 0 };
        byMode[r.mode].total += 1;
        if (r.conjunction_result === 1) {
          byMode[r.mode].verified += 1;
        }
        if (r.conjunction_result === 0) {
          byMode[r.mode].flagged += 1;
        }
      }
      if (date && weeklyMap.has(date)) {
        weeklyMap.set(date, (weeklyMap.get(date) || 0) + 1);
        if (r.conjunction_result === 1) {
          weeklyVerifiedMap.set(date, (weeklyVerifiedMap.get(date) || 0) + 1);
        }
      }
    });

    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      weekly.push({ date: key, count: weeklyMap.get(key) || 0, verified: weeklyVerifiedMap.get(key) || 0 });
    }

    const byModeArray = Object.keys(byMode).map(mode => ({
      mode,
      count: byMode[mode].total
    }));

    res.json({ total, verified, flagged, weekly, byMode: byModeArray });
  } catch (e) {
    console.error('/api/metrics error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`VerifiedPulse server running on http://localhost:${PORT}`);
});


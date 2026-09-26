const fetch = require('node-fetch');
const { callLLM, formatSearchEvidence } = require('./llm-providers');
const { insertCheck, upsertProviderStats } = require('./database');
const { readJsonBody, sendJson } = require('./http');

async function searchWeb(claim) {
  const apiKey = process.env.SEARCH_API_KEY;
  const maxResults = parseInt(process.env.SEARCH_MAX_RESULTS || '5', 10);

  if (!apiKey) {
    throw new Error('Search API key not configured. Set SEARCH_API_KEY in environment.');
  }

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
      const errorText = await res.text();
      throw new Error(`Search API error (${res.status}): ${errorText.slice(0, 200)}`);
    }

    return await res.json();
  } catch (e) {
    console.error('Search failed:', e.message);
    throw e;
  }
}

async function handleCheckClaim(req, res) {
  const method = (req.method || 'POST').toUpperCase();

  if (method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }

  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) {
    sendJson(res, 400, { error: 'Claim text is required' });
    return;
  }

  let searchEvidence;
  try {
    searchEvidence = await searchWeb(claim);
  } catch (e) {
    console.error('Search step failed:', e.message);
    sendJson(res, 502, { error: 'Search service unavailable', details: e.message });
    return;
  }

  const formattedEvidence = formatSearchEvidence(searchEvidence);

  let result;
  try {
    result = await callLLM(claim, formattedEvidence, Array.isArray(body.propositions) ? body.propositions : null);
  } catch (e) {
    console.error('/api/check-claim LLM error:', e);
    if (e.message && e.message.includes('No working LLM')) {
      sendJson(res, 503, { error: 'No working LLM' });
    } else {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  const conjunctionResult = Boolean(result.conjunction_result) && result.propositions.every(p => p.value === true);
  const provider = result.provider || 'heuristic';

  const checkRecord = {
    claim,
    mode: 'text',
    propositions: JSON.stringify(result.propositions),
    conjunction_result: conjunctionResult ? 1 : 0,
    search_evidence: searchEvidence ? JSON.stringify(searchEvidence) : null,
    created_at: new Date().toISOString()
  };

  try {
    await insertCheck(checkRecord);
  } catch (err) {
    console.error('Failed to insert check into database:', err);
  }

  try {
    await upsertProviderStats({
      name: provider,
      model: result.model || 'unknown',
      stats: {
        calls: 1,
        successes: conjunctionResult ? 1 : 0,
        failures: conjunctionResult ? 0 : 1,
        lastError: null,
        rateLimitCount: 0,
        suspendedUntil: null
      }
    });
  } catch (err) {
    console.error('Failed to update provider stats:', err);
  }

  sendJson(res, 200, {
    claim,
    mode: 'text',
    propositions: result.propositions,
    conjunction_result: conjunctionResult,
    search_evidence: searchEvidence,
    provider,
    warnings: result.warnings || [],
    rateLimitedProviders: result.rateLimitedProviders || []
  });
}

module.exports = {
  handleCheckClaim,
  searchWeb
};

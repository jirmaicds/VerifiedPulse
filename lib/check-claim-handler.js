const fetch = require('node-fetch');
const { callLLM, filterSupportingSources } = require('./llm-providers');
const { insertCheck, upsertProviderStats } = require('./database');
const { readJsonBody, sendJson } = require('./http');

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

  let searchEvidence = null;
  try {
    searchEvidence = await searchWeb(claim);
  } catch (e) {
    console.error('Search step failed (continuing without search):', e.message);
  }

  // Filter sources to only those that SUPPORT the claim
  // (not just topically related - must actively corroborate the claim)
  if (searchEvidence) {
    try {
      searchEvidence = await filterSupportingSources(claim, searchEvidence);
    } catch (e) {
      console.error('Source filtering failed (keeping original results):', e.message);
    }
  }

  let result;
  try {
    result = await callLLM(claim, searchEvidence, Array.isArray(body.propositions) ? body.propositions : null);
  } catch (e) {
    console.error('/api/check-claim error:', e);
    sendJson(res, 500, { error: e.message });
    return;
  }

  const conjunctionResult = Boolean(result.conjunction_result);
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

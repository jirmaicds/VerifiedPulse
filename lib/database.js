const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function ensureDatabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured');
  }
  return supabase;
}

async function insertCheck(check) {
  const { data, error } = await ensureDatabase()
    .from('checks')
    .insert({
      claim: check.claim,
      mode: check.mode,
      propositions: check.propositions,
      conjunction_result: check.conjunction_result,
      search_evidence: check.search_evidence,
      created_at: check.created_at
    })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to insert check:', error.message);
    throw error;
  }
  return data;
}

async function getMetrics() {
  const { count: total, error: countError } = await ensureDatabase()
    .from('checks')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error('Failed to fetch metrics totals:', countError.message);
    throw countError;
  }

  const totalCount = total || 0;
  const { data: verifiedRows, error: verifiedError } = await ensureDatabase()
    .from('checks')
    .select('conjunction_result', { count: 'exact', head: false })
    .eq('conjunction_result', 1);

  if (verifiedError) {
    console.error('Failed to fetch verified count:', verifiedError.message);
    throw verifiedError;
  }

  const verified = verifiedRows ? verifiedRows.length : 0;
  const flagged = totalCount - verified;

  const { data: rows, error: rowsError } = await ensureDatabase()
    .from('checks')
    .select('mode, conjunction_result, created_at')
    .order('created_at', { ascending: true });

  if (rowsError) {
    console.error('Failed to fetch metrics rows:', rowsError.message);
    throw rowsError;
  }

  const today = new Date();
  const weeklyMap = new Map();
  const weeklyVerifiedMap = new Map();
  const trustedSourceMap = new Map();

  const TRUSTED_CATEGORIES = {
    'Government Agencies': ['phivolcs', 'usgs', 'who', 'doh', 'comelec', 'deped', 'bsp', 'pse', 'pagasa', 'official government'],
    'International News': ['reuters', 'bbc', 'bbc news', 'ap', 'associated press', 'afp'],
    'Scientific/Technical': ['nasa', 'nasa.gov'],
    'Fact-Checking Orgs': ['factcheck.org', 'snopes']
  };

  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    weeklyMap.set(key, 0);
    weeklyVerifiedMap.set(key, 0);
  }

  (rows || []).forEach(r => {
    const date = r.created_at ? r.created_at.slice(0, 10) : null;
    if (date && weeklyMap.has(date)) {
      weeklyMap.set(date, (weeklyMap.get(date) || 0) + 1);
      if (r.conjunction_result === 1) {
        weeklyVerifiedMap.set(date, (weeklyVerifiedMap.get(date) || 0) + 1);
      }
    }

    let evidence = null;
    try {
      evidence = r.search_evidence ? JSON.parse(r.search_evidence) : null;
    } catch (e) {
      evidence = null;
    }

    if (evidence && evidence.results) {
      evidence.results.forEach(result => {
        const url = (result.url || result.link || '').toLowerCase();
        const title = (result.title || '').toLowerCase();
        const content = (result.content || '').toLowerCase();
        const combined = url + ' ' + title + ' ' + content;

        for (const [category, keywords] of Object.entries(TRUSTED_CATEGORIES)) {
          const matched = keywords.some(kw => combined.includes(kw));
          if (matched) {
            trustedSourceMap.set(category, (trustedSourceMap.get(category) || 0) + 1);
          }
        }
      });
    }
  });

  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    weekly.push({
      date: key,
      count: weeklyMap.get(key) || 0,
      verified: weeklyVerifiedMap.get(key) || 0
    });
  }

  const trustedSources = Array.from(trustedSourceMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  if (trustedSources.length === 0) {
    trustedSources.push(
      { category: 'Government Agencies', count: 0 },
      { category: 'International News', count: 0 },
      { category: 'Scientific/Technical', count: 0 },
      { category: 'Fact-Checking Orgs', count: 0 }
    );
  }

  return { total: totalCount, verified, flagged, weekly, trustedSources };
}

async function upsertProviderStats(providerStats) {
  const now = new Date().toISOString();
  const { data: existing, error: fetchError } = await ensureDatabase()
    .from('providers')
    .select('*')
    .eq('name', providerStats.name)
    .maybeSingle();

  if (fetchError && fetchError.code !== 'PGRST116') {
    console.error('Failed to fetch existing provider:', fetchError.message);
    throw fetchError;
  }

  const payload = {
    name: providerStats.name,
    model: providerStats.model,
    calls: (existing ? existing.calls : 0) + (providerStats.stats.calls || 0),
    successes: (existing ? existing.successes : 0) + (providerStats.stats.successes || 0),
    failures: (existing ? existing.failures : 0) + (providerStats.stats.failures || 0),
    last_error: providerStats.stats.lastError || null,
    last_used: now,
    rate_limit_count: (existing ? existing.rate_limit_count : 0) + (providerStats.stats.rateLimitCount || 0),
    suspended_until: providerStats.stats.suspendedUntil || null
  };

  const { data, error } = await ensureDatabase()
    .from('providers')
    .upsert(payload, { onConflict: 'name' })
    .select()
    .single();

  if (error) {
    console.error('Failed to upsert provider stats:', error.message);
    throw error;
  }
  return data;
}

async function getAllProviderStats() {
  const { data, error } = await ensureDatabase()
    .from('providers')
    .select('*');

  if (error) {
    console.error('Failed to fetch provider stats:', error.message);
    throw error;
  }
  return data;
}

module.exports = {
  supabase,
  insertCheck,
  getMetrics,
  upsertProviderStats,
  getAllProviderStats
};

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { classifyPropositions } = require('./risk');
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

function hashClaim(claim) {
  return crypto.createHash('sha256').update(claim.trim().toLowerCase()).digest('hex');
}

async function insertCheck(check) {
  const { data, error } = await ensureDatabase()
    .from('checks')
    .insert({
      claim: check.claim,
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

/**
 * Records a flagged claim in the misinformation tracking tables.
 * Shares, impressions and platform are left null because this project has no
 * social platform ingestion; the risk score and category are derived from the
 * proposition states so misinterpretations are not counted as fabrications.
 */
async function insertMisinformationEvent({ claim, propositions, conjunctionResult, platform }) {
  const risk = classifyPropositionsSafe(propositions);

  const row = {
    claim,
    claim_hash: hashClaim(claim),
    conjunction_result: conjunctionResult ? 1 : 0,
    misinformation_risk_score: risk.riskScore,
    risk_category: risk.category,
    p_state: risk.pValue,
    q_state: risk.qValue,
    platform: platform || 'unspecified',
    shares: 0,
    impressions: 0,
    engagement_rate: 0,
    spread_velocity: 0
  };

  const { data, error } = await ensureDatabase()
    .from('misinformation_events')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error('Failed to insert misinformation event:', error.message);
    return null;
  }
  return data;
}

function classifyPropositionsSafe(propositions) {
  try {
    const parsed = typeof propositions === 'string' ? JSON.parse(propositions) : propositions;
    return classifyPropositions(parsed);
  } catch (e) {
    return classifyPropositions([]);
  }
}

async function getMetrics() {
  try {
    console.log('[getMetrics] Starting metrics fetch...');
    
    console.log('[getMetrics] Query 1: total count');
    const { count: total, error: countError } = await ensureDatabase()
      .from('checks')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      console.error('[getMetrics] Query 1 FAILED:', countError.message, countError.details, countError.hint, countError.code);
      throw countError;
    }
    console.log('[getMetrics] Query 1 OK, total:', total);

    const totalCount = total || 0;
    console.log('[getMetrics] Query 2: verified count');
    const { data: verifiedRows, error: verifiedError } = await ensureDatabase()
      .from('checks')
      .select('conjunction_result', { count: 'exact', head: false })
      .eq('conjunction_result', 1);

    if (verifiedError) {
      console.error('[getMetrics] Query 2 FAILED:', verifiedError.message, verifiedError.details, verifiedError.hint, verifiedError.code);
      throw verifiedError;
    }
    console.log('[getMetrics] Query 2 OK, verified rows:', verifiedRows?.length);

    const verified = verifiedRows ? verifiedRows.length : 0;
    const flagged = totalCount - verified;

    console.log('[getMetrics] Query 3: rows for weekly/trusted sources');
    const { data: rows, error: rowsError } = await ensureDatabase()
      .from('checks')
      .select('conjunction_result, created_at, search_evidence')
      .order('created_at', { ascending: true });

    if (rowsError) {
      console.error('[getMetrics] Query 3 FAILED:', rowsError.message, rowsError.details, rowsError.hint, rowsError.code);
      throw rowsError;
    }
    console.log('[getMetrics] Query 3 OK, rows:', rows?.length);

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

  console.log('[getMetrics] Query 4: misinformation events');
  const { data: misinfoEvents, error: misinfoError } = await ensureDatabase()
    .from('misinformation_events')
    .select('claim, platform, shares, impressions, misinformation_risk_score, risk_category, p_state, q_state, detection_timestamp');

  if (misinfoError) {
    console.error('[getMetrics] Query 4 FAILED:', misinfoError.message, misinfoError.details, misinfoError.hint, misinfoError.code);
  } else {
    console.log('[getMetrics] Query 4 OK, events:', misinfoEvents?.length);
  }

  const misinfoEventsData = misinfoEvents || [];

   const totalMisinformationEvents = misinfoEventsData.length;
   const activeMisinformationEvents = totalMisinformationEvents;

   const avgRiskScore = misinfoEventsData.length > 0
     ? misinfoEventsData.reduce((sum, e) => sum + (e.misinformation_risk_score || 0), 0) / misinfoEventsData.length
     : 0;

   const riskDistribution = {
    low: misinfoEventsData.filter(e => (e.misinformation_risk_score || 0) < 30).length,
    medium: misinfoEventsData.filter(e => (e.misinformation_risk_score || 0) >= 30 && (e.misinformation_risk_score || 0) < 70).length,
    high: misinfoEventsData.filter(e => (e.misinformation_risk_score || 0) >= 70).length
  };

  const categoryBreakdown = new Map();
  misinfoEventsData.forEach(e => {
    let category = e.risk_category;
    if (!category) {
      category = classifyPropositionsSafe([
        { state: e.p_state },
        { state: e.q_state }
      ]).category;
    }
    categoryBreakdown.set(category, (categoryBreakdown.get(category) || 0) + 1);
  });

  const categories = Array.from(categoryBreakdown.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: totalCount,
    verified,
    flagged,
    weekly,
    trustedSources,
    misinformation: {
      totalEvents: totalMisinformationEvents,
      activeEvents: activeMisinformationEvents,
      avgRiskScore: Math.round(avgRiskScore * 100) / 100,
      riskDistribution,
      categories
    }
  };
  } catch (e) {
    console.error('[getMetrics] UNEXPECTED ERROR:', e.message);
    console.error('[getMetrics] Stack:', e.stack);
    console.error('[getMetrics] FULL ERROR OBJECT:', JSON.stringify(e, null, 2));
    if (e.message?.includes('WITHIN GROUP')) {
      console.error('[getMetrics] PostgreSQL ordered-set aggregate error - check views/functions/triggers for percentile_cont, percentile_disc, mode() without WITHIN GROUP');
    }
    throw e;
  }
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
  insertMisinformationEvent,
  getMetrics,
  upsertProviderStats,
  getAllProviderStats
};

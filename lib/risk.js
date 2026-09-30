/**
 * Misinformation risk scoring
 * ===========================
 * A failed conjunction (p ∧ q) is not by itself evidence of misinformation.
 * A claim can fail because it is fabricated, because it misinterprets real
 * reporting, or because no source addresses it at all. Those cases are
 * scored differently so the dashboard does not report them as one bucket.
 *
 * Each proposition resolves to one of three states:
 *   true       - positively supported by the evidence
 *   unverified - evidence is silent or insufficient, nothing contradicts it
 *   false      - evidence contradicts it, or support is refuted
 *
 * Risk is interpolated bilinearly over the four (true, false) corners so that
 * an unverified proposition lands halfway between "supported" and "refuted"
 * rather than being treated as a refutation.
 */

const VALUES = ['true', 'unverified', 'false'];

const WEIGHT = {
  true: 0,
  unverified: 0.5,
  false: 1
};

// Corner scores: p ∧ q with both propositions fully resolved.
const CORNER_SCORE = {
  'true|true': 0,
  'true|false': 40,
  'false|true': 55,
  'false|false': 90
};

const CATEGORY = {
  'true|true': 'verified',
  'true|false': 'uncorroborated-official',
  'false|true': 'possible-misinterpretation',
  'false|false': 'likely-fabrication'
};

const LABEL = {
  'verified': 'Verified',
  'uncorroborated-official': 'Official but uncorroborated',
  'possible-misinterpretation': 'Possible misinterpretation',
  'likely-fabrication': 'Likely fabrication',
  'insufficient-evidence': 'Insufficient evidence',
  'unsupported-claim': 'Unsupported claim'
};

function normalizeValue(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'verified') return 'true';
    if (v === 'false' || v === 'refuted') return 'false';
    if (v === 'unverified' || v === 'unknown' || v === 'insufficient') return 'unverified';
  }
  return 'unverified';
}

function interpolate(wP, wQ) {
  const tt = CORNER_SCORE['true|true'] * (1 - wQ) + CORNER_SCORE['true|false'] * wQ;
  const ft = CORNER_SCORE['false|true'] * (1 - wQ) + CORNER_SCORE['false|false'] * wQ;
  return tt * (1 - wP) + ft * wP;
}

function classify(pValue, qValue) {
  const p = normalizeValue(pValue);
  const q = normalizeValue(qValue);
  const score = Math.round(interpolate(WEIGHT[p], WEIGHT[q]));

  let category;
  if (p === 'unverified' || q === 'unverified') {
    const other = p === 'unverified' ? q : p;
    category = other === 'false' ? 'unsupported-claim' : 'insufficient-evidence';
  } else {
    category = CATEGORY[`${p}|${q}`];
  }

  let severity = 'low';
  if (score >= 70) severity = 'high';
  else if (score >= 30) severity = 'medium';

  return {
    pValue: p,
    qValue: q,
    riskScore: score,
    category,
    categoryLabel: LABEL[category],
    severity,
    isMisinformationCandidate: category === 'likely-fabrication' || category === 'unsupported-claim',
    conjunctionResult: p === 'true' && q === 'true'
  };
}

function propositionState(prop) {
  if (!prop) return 'unverified';
  if (prop.state) return prop.state;
  return prop.value;
}

function classifyPropositions(propositions) {
  const list = Array.isArray(propositions) ? propositions : [];
  return classify(
    list.length > 0 ? propositionState(list[0]) : 'unverified',
    list.length > 1 ? propositionState(list[1]) : 'unverified'
  );
}

module.exports = {
  VALUES,
  CATEGORY,
  LABEL,
  normalizeValue,
  classify,
  classifyPropositions
};

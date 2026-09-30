-- VerifiedPulse misinformation risk-scoring migration
-- Run in Supabase SQL Editor on an existing deployment where
-- public.misinformation_events already exists.

ALTER TABLE public.misinformation_events
  ADD COLUMN IF NOT EXISTS risk_category TEXT,
  ADD COLUMN IF NOT EXISTS p_state TEXT,
  ADD COLUMN IF NOT EXISTS q_state TEXT;

ALTER TABLE public.misinformation_events
  ALTER COLUMN platform SET DEFAULT 'unspecified';

CREATE INDEX IF NOT EXISTS idx_misinformation_events_risk_category
  ON public.misinformation_events(risk_category);

-- Backfill category and risk score for events recorded before this change.
-- p_state / q_state are unknown for historical rows, so they are derived from
-- the original conjunction result: flagged rows had at least one false
-- proposition, and the pattern is not recoverable, so treat them as
-- unsupported rather than fabricating a pattern.
UPDATE public.misinformation_events
SET p_state = COALESCE(p_state, 'unverified'),
    q_state = COALESCE(q_state, 'unverified'),
    risk_category = COALESCE(risk_category, 'unsupported-claim')
WHERE risk_category IS NULL;

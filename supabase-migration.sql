CREATE TABLE IF NOT EXISTS public.checks (
    id bigserial PRIMARY KEY,
    claim text NOT NULL,
    mode text NOT NULL,
    fb_url text,
    propositions text NOT NULL,
    conjunction_result integer NOT NULL,
    fb_context text,
    search_evidence text,
    created_at timestamptz DEFAULT now()
);

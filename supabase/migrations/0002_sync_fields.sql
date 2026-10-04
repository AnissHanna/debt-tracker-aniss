-- My Debt Tracker 🎀 — sync fields (run after 0001). Non-destructive, re-runnable.
-- extra: app fields that have no dedicated column (e.g. payments.applyAdvance), never used for maths.
-- client_updated_at: when the edit was made on the device; used for "newest edit wins" between devices.

alter table public.payments            add column if not exists extra jsonb not null default '{}'::jsonb;
alter table public.personal_borrowings add column if not exists extra jsonb not null default '{}'::jsonb;
alter table public.vehicle_settlements add column if not exists extra jsonb not null default '{}'::jsonb;

alter table public.debts               add column if not exists client_updated_at timestamptz;
alter table public.payments            add column if not exists client_updated_at timestamptz;
alter table public.personal_borrowings add column if not exists client_updated_at timestamptz;
alter table public.vehicle_settlements add column if not exists client_updated_at timestamptz;
alter table public.attachments         add column if not exists client_updated_at timestamptz;

-- Incremental pull ("what changed since my last sync") reads by updated_at.
create index if not exists debts_user_updated_idx       on public.debts (user_id, updated_at);
create index if not exists payments_user_updated_idx    on public.payments (user_id, updated_at);
create index if not exists borrowings_user_updated_idx  on public.personal_borrowings (user_id, updated_at);
create index if not exists settlements_user_updated_idx on public.vehicle_settlements (user_id, updated_at);
create index if not exists attachments_user_updated_idx on public.attachments (user_id, updated_at);

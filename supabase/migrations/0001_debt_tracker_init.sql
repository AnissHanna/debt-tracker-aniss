-- My Debt Tracker 🎀 — initial schema
-- Run ONLY in the NEW dedicated "debt-tracker" Supabase project (never in ZUUWA).
-- Non-destructive: no DROP, no TRUNCATE, no DELETE. Safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING).

create extension if not exists pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────
do $$ begin create type public.debt_type as enum ('monthly','one_time','personal','credit_card');
exception when duplicate_object then null; end $$;
do $$ begin create type public.obligation_kind as enum ('installment','opening_arrears');
exception when duplicate_object then null; end $$;
do $$ begin create type public.obligation_status as enum ('upcoming','partial','paid','overdue');
exception when duplicate_object then null; end $$;
do $$ begin create type public.overpayment_status as enum ('open','resolved');
exception when duplicate_object then null; end $$;
do $$ begin create type public.vehicle_kind as enum ('car','motorcycle');
exception when duplicate_object then null; end $$;
do $$ begin create type public.ownership_status as enum
  ('loan_active','paid_awaiting_letter','letter_received','ownership_in_progress','completed');
exception when duplicate_object then null; end $$;
do $$ begin create type public.attachment_kind as enum ('payment_proof','borrowing_receipt','settlement_letter');
exception when duplicate_object then null; end $$;

-- ── updated_at trigger ───────────────────────────────────────────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- ── Debts (source of truth) ──────────────────────────────────────────────
create table if not exists public.debts (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references auth.users(id) on delete cascade,
  legacy_id               text,                       -- e.g. 'DEBT-0001' from local data, for idempotent import
  name                    text not null check (length(trim(name)) > 0),
  debt_type               public.debt_type not null,
  category                text not null default 'Other',
  bank                    text,
  account_number          text,                       -- shown masked (last 4) in the UI
  monthly_payment         numeric(12,2) check (monthly_payment >= 0),
  first_due_date          date,
  due_day                 smallint check (due_day between 1 and 31),
  opening_arrears         numeric(12,2) check (opening_arrears >= 0),
  arrears_as_of           date,
  original_amount         numeric(12,2) check (original_amount >= 0),
  total_loan_amount       numeric(12,2) check (total_loan_amount >= 0),
  loan_start_date         date,
  loan_term_months        integer check (loan_term_months >= 0),
  remaining_tenure_months integer check (remaining_tenure_months >= 0),
  estimated_end_date      date,
  current_balance         numeric(12,2),              -- credit card balance
  minimum_payment         numeric(12,2) check (minimum_payment >= 0),
  interest_rate           numeric(6,3) check (interest_rate >= 0),
  interest_rate_unit      text,
  amount_due              numeric(12,2) check (amount_due >= 0),   -- one-time debts
  due_date                date,                                    -- one-time due date / personal target date
  notes                   text,
  is_active               boolean not null default true,
  needs_check             boolean not null default false,
  extra                   jsonb not null default '{}'::jsonb,      -- snapshot info and future fields, never used for maths
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  unique (id, user_id)
);
create unique index if not exists debts_user_legacy_uq on public.debts (user_id, legacy_id) where legacy_id is not null;
create index if not exists debts_user_type_idx on public.debts (user_id, debt_type) where deleted_at is null;
create index if not exists debts_user_due_idx  on public.debts (user_id, due_date)  where deleted_at is null;

-- ── Personal-debt borrowing records ──────────────────────────────────────
create table if not exists public.personal_borrowings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt_id     uuid not null,
  legacy_id   text,
  borrowed_on date not null,
  amount      numeric(12,2) not null check (amount > 0),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (id, user_id),
  foreign key (debt_id, user_id) references public.debts (id, user_id) on delete cascade
);
create unique index if not exists borrowings_user_legacy_uq on public.personal_borrowings (user_id, legacy_id) where legacy_id is not null;
create index if not exists borrowings_debt_idx on public.personal_borrowings (debt_id, borrowed_on) where deleted_at is null;

-- ── Payments (source of truth; amount is always the full original amount) ─
create table if not exists public.payments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt_id    uuid not null,
  legacy_id  text,
  paid_on    date not null,
  amount     numeric(12,2) not null check (amount > 0),
  method     text,
  reference  text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, user_id),
  foreign key (debt_id, user_id) references public.debts (id, user_id) on delete cascade
);
create unique index if not exists payments_user_legacy_uq on public.payments (user_id, legacy_id) where legacy_id is not null;
create index if not exists payments_debt_date_idx on public.payments (debt_id, paid_on) where deleted_at is null;
create index if not exists payments_user_date_idx on public.payments (user_id, paid_on) where deleted_at is null;

-- ── Monthly obligations (derived; rebuilt by the app's existing logic) ───
create table if not exists public.monthly_obligations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt_id      uuid not null,
  kind         public.obligation_kind not null default 'installment',
  period_month date not null check (extract(day from period_month) = 1),
  due_date     date,
  label        text,
  amount_due   numeric(12,2) not null check (amount_due >= 0),
  amount_paid  numeric(12,2) not null default 0 check (amount_paid >= 0),
  status       public.obligation_status not null default 'upcoming',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id),
  unique (debt_id, kind, period_month),
  check (amount_paid <= amount_due),
  foreign key (debt_id, user_id) references public.debts (id, user_id) on delete cascade
);
create index if not exists obligations_user_month_idx on public.monthly_obligations (user_id, period_month);
create index if not exists obligations_debt_status_idx on public.monthly_obligations (debt_id, status);

-- ── Payment allocations (derived) ────────────────────────────────────────
-- obligation_id is NULL for credit-card / one-time / personal payments (balance-type debts).
create table if not exists public.payment_allocations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payment_id       uuid not null,
  debt_id          uuid not null,
  obligation_id    uuid,
  amount           numeric(12,2) not null check (amount > 0),
  allocation_order smallint not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (payment_id, user_id)    references public.payments (id, user_id) on delete cascade,
  foreign key (debt_id, user_id)       references public.debts (id, user_id) on delete cascade,
  foreign key (obligation_id, user_id) references public.monthly_obligations (id, user_id) on delete cascade
);
create index if not exists allocations_payment_idx    on public.payment_allocations (payment_id);
create index if not exists allocations_obligation_idx on public.payment_allocations (obligation_id);

-- ── Unallocated overpayments (derived amount, user-owned status/note) ────
-- Example: RM800 paid on a RM742.35 installment → RM57.65 kept here, never pushed into next month.
create table if not exists public.unallocated_overpayments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payment_id      uuid not null unique,
  debt_id         uuid not null,
  amount          numeric(12,2) not null check (amount > 0),
  status          public.overpayment_status not null default 'open',
  resolution_note text,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (payment_id, user_id) references public.payments (id, user_id) on delete cascade,
  foreign key (debt_id, user_id)    references public.debts (id, user_id) on delete cascade
);
create index if not exists overpayments_user_status_idx on public.unallocated_overpayments (user_id, status);

-- ── Vehicle / motorcycle settlement & ownership ──────────────────────────
-- Ownership is only "completed" when the user sets it; never automatic on full payment.
create table if not exists public.vehicle_settlements (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt_id                  uuid not null unique,
  vehicle_kind             public.vehicle_kind not null,
  plate_number             text,
  fully_paid_on            date,
  ownership_status         public.ownership_status not null default 'loan_active',
  letter_requested_on      date,
  letter_received_on       date,
  ownership_completed_on   date,
  reminder_dismissed_until date,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (id, user_id),
  check (ownership_status <> 'completed' or ownership_completed_on is not null),
  foreign key (debt_id, user_id) references public.debts (id, user_id) on delete cascade
);
create index if not exists settlements_user_status_idx on public.vehicle_settlements (user_id, ownership_status) where deleted_at is null;

-- ── File metadata (receipts, payment proofs, settlement letters) ─────────
create table if not exists public.attachments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind              public.attachment_kind not null,
  payment_id        uuid,
  borrowing_id      uuid,
  settlement_id     uuid,
  bucket            text not null check (bucket in ('payment-proofs','settlement-letters')),
  storage_path      text not null unique,          -- '<user_id>/<parent_id>/<attachment_id>.<ext>'
  mime_type         text,
  size_bytes        bigint check (size_bytes >= 0),
  original_filename text,
  legacy_key        text,                          -- IndexedDB key it was imported from
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  check (
    (kind = 'payment_proof'     and payment_id is not null and borrowing_id is null and settlement_id is null and bucket = 'payment-proofs') or
    (kind = 'borrowing_receipt' and borrowing_id is not null and payment_id is null and settlement_id is null and bucket = 'payment-proofs') or
    (kind = 'settlement_letter' and settlement_id is not null and payment_id is null and borrowing_id is null and bucket = 'settlement-letters')
  ),
  foreign key (payment_id, user_id)    references public.payments (id, user_id) on delete cascade,
  foreign key (borrowing_id, user_id)  references public.personal_borrowings (id, user_id) on delete cascade,
  foreign key (settlement_id, user_id) references public.vehicle_settlements (id, user_id) on delete cascade
);
create index if not exists attachments_payment_idx    on public.attachments (payment_id)    where deleted_at is null;
create index if not exists attachments_borrowing_idx  on public.attachments (borrowing_id)  where deleted_at is null;
create index if not exists attachments_settlement_idx on public.attachments (settlement_id) where deleted_at is null;

-- ── Per-user settings ────────────────────────────────────────────────────
create table if not exists public.user_settings (
  user_id         uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  payment_methods text[] not null default array['Bank Transfer','Cash','Cheque','Other'],
  prefs           jsonb not null default '{}'::jsonb,
  local_import_at timestamptz,                      -- set once the local IndexedDB data has been imported
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── Triggers, RLS, grants ────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['debts','personal_borrowings','payments','monthly_obligations','payment_allocations',
                           'unallocated_overpayments','vehicle_settlements','attachments','user_settings'] loop
    execute format('create or replace trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    begin execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
    exception when duplicate_object then null; end;
    begin execute format('create policy %I on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    exception when duplicate_object then null; end;
    begin execute format('create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t || '_update_own', t);
    exception when duplicate_object then null; end;
  end loop;

  -- Hard DELETE only on derived tables that the app rebuilds. Everything else is soft-deleted (deleted_at).
  foreach t in array array['monthly_obligations','payment_allocations','unallocated_overpayments'] loop
    execute format('grant delete on public.%I to authenticated', t);
    begin execute format('create policy %I on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t || '_delete_own', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- ── Storage: private buckets, files under '<user_id>/...' ────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('payment-proofs',     'payment-proofs',     false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']),
  ('settlement-letters', 'settlement-letters', false, 20971520, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do nothing;

do $$ begin
  create policy "mdt files: read own" on storage.objects for select to authenticated
    using (bucket_id in ('payment-proofs','settlement-letters') and (storage.foldername(name))[1] = (select auth.uid())::text);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "mdt files: upload own" on storage.objects for insert to authenticated
    with check (bucket_id in ('payment-proofs','settlement-letters') and (storage.foldername(name))[1] = (select auth.uid())::text);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "mdt files: update own" on storage.objects for update to authenticated
    using (bucket_id in ('payment-proofs','settlement-letters') and (storage.foldername(name))[1] = (select auth.uid())::text)
    with check (bucket_id in ('payment-proofs','settlement-letters') and (storage.foldername(name))[1] = (select auth.uid())::text);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "mdt files: delete own" on storage.objects for delete to authenticated
    using (bucket_id in ('payment-proofs','settlement-letters') and (storage.foldername(name))[1] = (select auth.uid())::text);
exception when duplicate_object then null; end $$;

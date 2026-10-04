# My Debt Tracker → Supabase plan

## Where the data lives now
- `localStorage['mdt-data-v1']`: debts, payments, borrowings, payment methods, prefs, counters. IDs look like `DEBT-0001`, `PAY-0001`, `BOR-0001`.
- `IndexedDB 'mdt-receipts'` (store `r`): receipt images as data URLs, keyed by payment or borrowing id.
- Obligations, allocations and overpayments are not stored anywhere. They are worked out from debts and payments by `recalculateAllocations()`.

## Source of truth
- **Stored as entered:** `debts`, `payments`, `personal_borrowings`, `vehicle_settlements`, `attachments`, `user_settings`.
- **Derived snapshots:** `monthly_obligations`, `payment_allocations`, `unallocated_overpayments`. The app rebuilds these with its existing logic after every change and writes them back. They are never used to override the calculation.
- An overpayment's `status` and `resolution_note` are kept when it is rebuilt (upsert by `payment_id`).

## Tables
All tables have a UUID `id`, `user_id` (default `auth.uid()`), `created_at` and `updated_at`. Child rows reference their parent through `(id, user_id)`, so one user's rows can't point at another user's rows.

| Table | Purpose | Key relations | Soft delete |
|---|---|---|---|
| debts | All 4 debt types + loan, card and account fields | — | yes |
| personal_borrowings | Each time money was borrowed for a Personal Debt | → debts | yes |
| payments | Original payment, full amount (e.g. RM800) | → debts | yes |
| monthly_obligations | Installments + opening arrears, one row per debt/kind/month | → debts | rebuilt |
| payment_allocations | How each payment was split (oldest-first) | → payments, debts, obligations | rebuilt |
| unallocated_overpayments | Extra amount kept, e.g. RM57.65 | → payments (1:1), debts | rebuilt, status kept |
| vehicle_settlements | Car/motorcycle ownership steps, release letter dates | → debts (1:1) | yes |
| attachments | File metadata for payment proof, borrowing receipt, settlement letter | → payments / borrowings / settlements (exactly one) | yes |
| user_settings | Payment methods, prefs, local-import marker | → auth.users | — |

`legacy_id` on debts, payments and borrowings lets the local import run safely more than once without duplicates.

## Storage
- Private buckets `payment-proofs` (10 MB) and `settlement-letters` (20 MB). Accepted files: JPG, PNG, WEBP, HEIC, PDF.
- Path: `<user_id>/<parent_id>/<attachment_id>.<ext>`. Files are viewed through short-lived signed URLs.

## RLS
- RLS is on for every table. Signed-in users can select, insert and update only rows where `user_id = auth.uid()`. The `anon` role has no access.
- Hard DELETE is allowed only on the 3 derived tables. Debts, payments, borrowings, settlements and attachments use `deleted_at` instead.
- Storage policies only allow access to files whose first folder is the user's own id.

## Payment rule
- Unchanged. The existing tests already prove that excess money stays unallocated.
- I'll add an explicit test: RM742.35 installment, RM800 payment → RM742.35 marked paid, RM57.65 unallocated, next month untouched, payment still stored as RM800.

## Vehicle / motorcycle
- Applies to debts in the Car or Motorcycle category.
- When the outstanding balance reaches RM0, Debt Details shows a reminder to get the settlement/release letter. Ownership status moves to `paid_awaiting_letter`.
- You upload the letter and step the status yourself: letter received → ownership in progress → completed.
- `completed` needs a completion date that you enter. It is never set automatically.

## App changes (after you approve)
1. `config.js` is generated at deploy from the environment variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Only the publishable key is used; the service-role key is never in the app.
2. Uses `@supabase/supabase-js` v2 (loaded from a pinned CDN build so the single-file PWA keeps working).
3. Adds a sign-in screen (Supabase Auth). The UI is otherwise unchanged.
4. Local-first sync:
   - IndexedDB and localStorage stay as the offline cache.
   - Changes made offline are queued and pushed when the phone is back online.
   - If two devices edit the same row, the newest `updated_at` wins.
5. First sign-in offers **Import my existing data**:
   - uploads debts, payments, borrowings and receipts with new UUIDs, using `legacy_id` to map the old IDs
   - sets `local_import_at`
   - never deletes the local copy
6. All calculation code and tests stay as they are. New tests are added for sync mapping, overpayment and the settlement reminder.

## Setup you do (ZUUWA is untouched)
1. supabase.com → **New project** → name it `debt-tracker`. It is a separate project, so ZUUWA's database is not affected.
2. In the new project: SQL Editor → paste `migrations/0001_debt_tracker_init.sql` → Run.
3. Settings → API keys: copy the **Project URL** and the **Publishable key** (`sb_publishable_…`). Do not copy the secret or service-role key.
4. Authentication → URL Configuration: add your Netlify URL.

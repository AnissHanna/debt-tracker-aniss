# Supabase setup + test checklist

## 1. Database (one time, in the debt-tracker project only)
1. Supabase dashboard → open project **vfeqrlmoepsmvlgivlpb** (Debt Tracker, not ZUUWA).
2. SQL Editor → New query → paste `migrations/0001_debt_tracker_init.sql` → Run.
3. New query → paste `migrations/0002_sync_fields.sql` → Run.
4. Authentication → Sign In / Providers → Email: enabled. Keep "Confirm email" on if you like; the app handles it.
5. Authentication → URL Configuration → Site URL = your Netlify URL.

## 2. Deploy
- **Netlify Drop:** drag the `pwa` folder in. `pwa/config.js` already holds the URL + publishable key.
- **Netlify with env vars (optional):**
  - set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in Site settings → Environment variables
  - Build command: `node scripts/write-config.mjs`
  - Publish directory: `pwa`

## 3. Automated (run in the browser console by opening the app with `?test=1`)
- 57 calculation tests:
  - monthly obligation generation
  - oldest-first allocation
  - partial payments
  - payments spanning months
  - RM800 paid on a RM742.35 installment → RM57.65 unallocated
  - edit/delete recalculation
  - vehicle settlement reminder
  - personal debt, one-time debt, credit card, RHB
- 10 sync mapping tests:
  - round trip without false "changed" flags
  - credit card type mapping
  - RM800 kept as RM800
  - unknown fields preserved
  - payments held back until their debt is synced

## 4. Manual, on real devices (needs the SQL run first)
| Check | How |
|---|---|
| Sign up / sign in | Settings → Cloud Sync → Sign in → Create account |
| Import | After sign-in choose **Upload my data**. Check Table Editor → debts / payments / attachments |
| Overpayment | Record RM800 on a RM742.35 month → `unallocated_overpayments` has RM57.65, payment row = 800 |
| Edit / delete payment | Change or delete it → `payment_allocations` rebuilt. Deleted payment gets `deleted_at` (row kept) |
| Receipt | Add / view / replace / delete on a payment → `payment-proofs` bucket + `attachments` row |
| Settlement letter | Car / Motorcycle debt → Mark as settled → Upload letter → `settlement-letters` bucket |
| Reminder | Fully paid vehicle shows the reminder; ownership only completes when you tap Completed |
| Logout / login | Sign out, sign in again → same data |
| Two devices | Sign in on a second phone → **Use my cloud data**. Edit on one, then open the other → change appears within ~1 min or on reopen |
| Offline | Airplane mode → record a payment → Settings shows "Offline · 1 change". Turn data back on → it syncs |
| Safety | Clear All Data on one phone → sync pauses and asks "Bring them back / Remove from cloud" |

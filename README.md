# Finance Tracker (Google Sheets)

A personal finance tracker for Google Sheets. It comes in two forms:

1. **`sheets/finance-tracker-template.csv`** — a single-tab quick-start ledger
   you can import into Google Sheets in under a minute. Live formulas
   (running balance, totals, category breakdown) come along with the import.
2. **`apps-script/Code.gs`** — a Google Apps Script that builds the **full
   multi-tab tracker**: Clean Transactions, an **Account Summary** tab that shows real
   per-account balances from the bank feed (credit cards as debt), a Dashboard with **weekly & monthly**
   summaries plus **Cash / Credit / Net-worth** standing totals, **Recurring**
   monthly expenses, savings **Goals** (vacations, etc.), a **Categories** config
   tab that drives dropdowns and budgets, and a **built-in CSV importer**
   (Finance ▸ Import transactions) that cleans an Everlance export into the ledger
   — no external tools required.

Use the CSV for an instant ledger, then run the Apps Script when you want the
full dashboards and extra tabs.

---

## Option A — Use the CSV template (fastest)

The CSV already contains formulas (cells starting with `=`). Google Sheets
turns these into real formulas on import, so you get a working ledger
immediately.

**Import into a brand-new spreadsheet**

1. Go to <https://sheets.google.com> and open a **Blank** spreadsheet.
2. **File ▸ Import**.
3. Choose the **Upload** tab and select
   `sheets/finance-tracker-template.csv` (download it from this repo first).
4. Under *Import location* pick **Replace current sheet** (or *Create new
   spreadsheet*).
5. Set *Separator type* to **Comma** and leave
   **"Convert text to numbers, dates, and formulas"** ticked.
6. Click **Import data**.

You'll get:

| Date | Category | Description | Income | Expense | Balance | … | Summary |
|------|----------|-------------|-------:|--------:|--------:|---|---------|

- **Balance** auto-updates as a running total (`= previous balance + Income − Expense`).
- The **Summary** block on the right shows Total Income, Total Expense, Net,
  and a per-category spend breakdown (`SUMIF`).

**To start tracking:** delete the sample rows (rows 4–12, keep the header) or
edit them, then add your own. Type a new row for each transaction — put the
amount under **Income** or **Expense** and the balance recalculates. Drag the
`Balance` formula down if you add rows past the existing ones.

> Tip: keep dates in `YYYY-MM-DD` format so sorting and the Apps Script
> summaries work correctly.

---

## Option B — Build the full tracker with Apps Script

This creates all tabs with formatting, dropdowns, checkboxes and the
weekly/monthly dashboards.

1. Open a Google Sheet (a blank one, or the one you imported the CSV into).
2. **Extensions ▸ Apps Script**.
3. Delete any boilerplate, paste the contents of `apps-script/Code.gs`, and
   **Save**.
4. In the toolbar function dropdown choose **`setup`** and click **Run**.
5. Approve the permissions prompt the first time (it only edits this
   spreadsheet).
6. Switch back to the sheet — you'll see the tabs below, plus a new
   **Finance** menu (use *Finance ▸ Rebuild tracker* anytime).

Re-running `setup()` is safe: it preserves data you've typed and only
refreshes headers, formulas and formatting.

### Tabs

| Tab | What it does |
|-----|--------------|
| **Clean Transactions** | Your curated ledger, ordered **newest-first** (latest transaction at the top, oldest at the bottom — like a bank statement), with category dropdown, **Account** and **Type** (Cash/Credit) columns, currency formatting and a guarded running-cumulative-net formula. The **Balance** column accumulates from the bottom up, so the top row shows your current global net. Transfers between your own accounts carry the category **`Transfer`** so they move balances without distorting spend totals. A **filter** sits on the header — filter the **Account** column to one account (e.g. `Checking 3620`) to review it alone, and fix any row's **Category** by hand (the dropdown includes `Transfer`). Hand edits stick: re-importing never overwrites a row already in the sheet. *(The SheetLink add-on writes its **raw** feed to a separate tab named **`Transactions`**; Sync from SheetLink cleans that into this ledger — see below.)* |
| **Account Summary** | One clean row per account — just **Account, Type, and Balance**. **Balance** is the account's **real** balance from the bank feed (clean names, no cryptic IDs or doubled `••••1234` masks): for **cash** accounts it's the **available** balance (spendable = posted − pending, matching your banking app); for **credit cards** it's the amount **owed, shown negative** (a card you owe $1,703 on reads `-1703.33`). **Net worth on the Dashboard is the sum of this column.** *(SheetLink writes its raw balance dump to a separate tab named **`Accounts`**; Sync reads the latest snapshot from it and trims the older ones. If a balance is wrong, the bank feed is sending a stale value — reconnect that account in SheetLink.)* |
| **Dashboard** | Three standing balances — **Cash on hand**, **Credit (debt)** and **Net worth (all)** — from real feed balances on **Account Summary**; all-time income/expense/net and **last 12 months / 12 weeks** summaries (transfers excluded); category spend-vs-budget for the current month (overspend highlighted). Plus three charts: **cashflow over time**, **category spend pie**, and **goals progress**. ⚠️ Before your first **Sync from SheetLink** the balances are empty until the feed fills them. |
| **Recurring** | Monthly recurring bills (name, category, amount, due day, active checkbox) with an annual projection and monthly/annual totals. |
| **Goals** | Savings/earnings goals (e.g. vacations): target amount & date, saved so far, monthly contribution, with computed remaining, % complete, months left and an on-track flag. |
| **Categories** | Edit this list to change the dropdown options and per-category monthly budgets used by the Dashboard. |
| **Settings** | Personal lists the importer uses to recognise transfers between your own accounts (name, banks, cards), plus the **SheetLink** feed settings (which tab to read and the amount-sign toggle). Edit a row to add an account — no code changes. |

---

## Repo layout

```
finance-tracker/
├── README.md
├── sheets/
│   └── finance-tracker-template.csv   # importable single-tab ledger
├── scripts/
│   └── convert_everlance.py           # optional CLI converter (in-sheet import preferred)
└── apps-script/
    └── Code.gs                        # builds all tabs + the built-in CSV importer
```

## Automatic bank feed (SheetLink) — recommended

The simplest, most reliable way to keep the tracker current is an **automatic
bank feed**. [SheetLink](https://sheetlink.app) is a Google Sheets add-on
(Pro plan) that connects your bank accounts and writes your transactions — **and
your real account balances** — into tabs of this spreadsheet on a schedule. Because
it pulls *every* account automatically, you get **both legs of every transfer** and
nothing is skipped, which is what keeps per-account balances honest (no more
phantom surpluses from a missing month).

> **Raw vs. clean tabs, by design.** SheetLink hard-codes the names of the tabs it
> writes — **`Transactions`** (the raw transaction feed) and **`Accounts`** (its raw
> balance dump) — and you only choose the *file*, not the tab names. So we let SheetLink
> **own those two tabs as raw feeds** and keep our curated views on **separate** tabs it
> never touches:
> - **`Transactions`** (SheetLink, raw) → **`Clean Transactions`** (ours, curated ledger).
> - **`Accounts`** (SheetLink, raw balances) → **`Account Summary`** (ours, one clean row
>   per account with real balances).
>
> The Dashboard reads only the clean tabs. Don't rename them. (Earlier versions named our
> summary `Accounts`, which collided with SheetLink's — Rebuild migrates it to
> `Account Summary` automatically.)

**One-time setup:**

1. Install **SheetLink** from the Google Workspace Marketplace, point it at **this
   spreadsheet** (an "existing template"), and connect your accounts (Capital One,
   Truist, the cards, etc.). Let it write its **`Transactions`** tab (and, ideally,
   its balances tab).
2. Run **Finance ▸ Rebuild tracker** — this creates the **`Clean Transactions`**
   ledger and the **`Account Summary`** tab. The Settings default **SheetLink
   transactions tab = `Transactions`** already points at SheetLink's feed, so there's
   usually nothing to change. (The balances tab is found automatically by its columns —
   no name to configure.)

**Each sync (or let it run automatically):**

4. **Finance ▸ Sync from SheetLink** — the raw **`Transactions`** feed is normalized
   into the **`Clean Transactions`** ledger: amounts split into Income/Expense, accounts/types set,
   transfers between your own accounts tagged `Transfer`, categories mapped, and
   each row de-duped by its stable bank `transaction_id`. Your hand-labels are
   preserved. The summary reports what was added.
5. The **`Account Summary`** tab is rebuilt as **one clean row per account** — just
   **Account, Type, and Balance**. Clean names (no cryptic IDs, no doubled `••••1234`
   masks); **Balance** is the account's **real** balance from the feed, with **credit
   cards negative (debt)** — a card you owe $1,703 on reads `-1703.33`. **Net worth on
   the Dashboard is the sum of this column**, so card debt always counts even if some of
   a card's purchases haven't synced yet.
   - SheetLink re-appends a fresh copy of every account on each sync; **Sync from
     SheetLink trims those stale snapshots automatically**, keeping only the latest, so
     its `Accounts` tab stops growing without bound.

> **Sign check (do once):** banks/Plaid sign money *leaving* as positive. After
> your first sync, glance at one row — if a known **deposit** shows up as an
> **Expense**, set **SheetLink amount sign** to `in=positive` on the Settings tab
> and sync again. That's the only thing that ever needs adjusting.
>
> **Per-account exception:** some institutions sign *one* account backwards while
> the rest are fine — **Discover** credit cards are the known case (a purchase
> lands as Income). List such accounts in **Invert amount sign for (accounts)** on
> the Settings tab (seeded with `DISCOVER`); their amounts are flipped after the
> global toggle. Remove `DISCOVER` if yours already imports correctly.

> **Stop deleting transfers** in any upstream app. The Sheet tags transfers itself
> and needs **both legs** to keep balances correct — deleting one side is what
> created the earlier phantom balances.

## Importing transactions from a CSV (Everlance / fallback)

You can also import a CSV manually — useful as a fallback or before you set up the
feed. The importer is **part of the Apps Script** — no Python, no command line. You
pick a CSV from a pop-up and it's cleaned and written straight into the
**Clean Transactions** tab. It understands the [Everlance](https://everlance.com) export
format today; it's built as a small registry of **format profiles** (Everlance and
SheetLink ship in the box), so more banks can be added later without a rewrite.

**First-time setup (once):**

1. Run **Finance ▸ Rebuild tracker** so all tabs exist — including the new
   **Settings** tab.
2. Open the **Settings** tab and fill in the two identity rows — they ship
   **blank** (a shared copy carries nobody's personal details, so this is the one
   step you must do before your first sync):
   - **Your name (any spelling)** — every way the banks write your name, one per
     cell (e.g. `JOHN`, `J SMITH`, `SMITH`).
   - **Your handles & account numbers** — your own payment handles / identifiers:
     **Cash App tag**, Zelle email or phone, PayPal, account last-4 (e.g. `0864`).

   A row whose description contains **any** value from either row is treated as
   money moving between *your own* accounts and tagged `Transfer`. (The bank feed
   never names the other side in a column — only in the description text — so
   matching your identity there is the only reliable way to tell *your* transfers
   from real payments.) The other rows start blank or with generic payment-rail
   keywords; add your own banks, sub-accounts and cards as your accounts require
   (see below).

**Each import (as often as you like — daily is fine):**

3. **Finance ▸ Import transactions (CSV)…** → a pop-up opens.
4. Choose your Everlance CSV export and click **Import**. Only transactions not
   already in the sheet are **added** (matched on a hidden `Ref` column); the
   summary shows how many were added vs. already present. The ledger re-sorts by
   date, the running **Balance** recomputes, and any new account/card is
   auto-added to the **Account Summary** tab.
5. New accounts/cards appear on the **Account Summary** tab. Per-account **Balance** and
   the Dashboard's Cash / Credit / Net-worth totals come from the **SheetLink bank feed**
   (recommended above); on the CSV-only path that column stays blank — use the ledger's
   running **Balance** column for your overall position.

### What the importer does

- **splits the signed `Amount`** into Income/Expense;
- **tags each row with its Account and Type** — the bank account name (e.g.
  `Checking 1234`, `Visa Credit Card`) and whether it's `Cash` or `Credit`,
  so the **Account Summary** tab can derive per-account balances;
- **labels money between your own accounts `Transfer`** — when a row's description
  names **you** (any entry in **Your name** or **Your handles & account numbers** on
  the Settings tab), it's a move between your own accounts, not a real payment, so it's
  tagged `Transfer`. Money **out** to anyone else is an Expense and money **in**
  from anyone else is Income — exactly your rule. (Paying a friend on Cash App is
  an expense even though the bank, like Plaid, lumps all peer payments under
  "transfer"; only the *identity* tells them apart.) Credit-card payments are also
  tagged `Transfer` (both legs — the money leaving checking and the matching
  "payment received" on the card, including issuer-name-only debits). `Transfer`
  rows move balances (paying a card lowers cash **and** card debt) but the Dashboard
  excludes them from income/expense/spend totals, so nothing is double-counted.
  Purchases made **on** a card stay as ordinary expenses. The summary flags any
  transfer in/out **imbalance** — a transfer whose matching leg is missing from the
  feed, which may still be inflating an account's balance;
- **removes exact-duplicate transactions** — if an account was synced twice, the
  same charge appears 2–3× with an identical bank reference; each real
  transaction is counted once (keyed on amount + date + merchant + bank
  description + account, ignoring tag/category columns);
- maps Everlance's ~70 categories down to the tracker's 10, classifying
  vaguely-labelled bank rows (e.g. "Debit") by **merchant keyword** so the
  GasBuddy fuel app lands in Transport instead of the catch-all "Other";
- **reads checks by direction** — a check/money order you *write* is an Expense,
  a check you *deposit* is Income (Everlance tags both "Check", so the amount's
  sign decides), and any **Lender** named on the Settings tab is treated as loan
  Income on the way in and a repayment Expense on the way out.

### Fixing a transaction's classification by hand

Auto-detection is only a **first guess** — you always have the final say, and the
sheet is built so your corrections are permanent:

1. On the **Clean Transactions** tab, click the filter on the **Account** header and
   tick a single account (e.g. `Checking 3620`) to see only its rows.
2. For each row, set the **Category** (column B) with the dropdown:
   - **`Transfer`** — money moved between your own accounts (or a card payment).
     Transfers still move account balances but are **excluded** from income,
     expense and spend totals, so they don't inflate anything.
   - any spending category (Groceries, Transport, …) for a real **expense**;
   - **`Income`** for real income.
   The Income/Expense **amount** stays in its column (D or E) — changing the
   Category is all that's needed to fix how a row is counted.
3. That's it. The next import **keeps your edits**: rows already in the sheet are
   matched by their hidden `Ref` and never re-classified, so you only ever label
   a transaction once.

Tip: filtering (hiding rows) keeps the running **Balance** column correct;
*sorting* physically reorders rows so that global column reflows — re-sort by
**Date**, or run **Finance ▸ Rebuild tracker**, to restore it. Your data and
labels are never affected either way.

### Importing again — daily, weekly, whenever

Because imports are **incremental**, you never have to re-export your whole
history. Export whatever Everlance has (the latest day, the latest week, or the
full file — it doesn't matter) and run **Finance ▸ Import transactions (CSV)…**.
Only transactions the sheet hasn't seen are added; anything already present is
skipped, so re-importing the same file twice changes nothing. The balance,
Accounts and Dashboard recompute automatically, and your opening balances stay
put.

> **Bank-sync note:** Everlance only has a transaction once your bank feeds it
> (often a day or two later), so "today's" purchase may not appear until a later
> import regardless of how often you run it.

> **When you add or close an account/card:** the importer recognises your
> transfers using the lists on the **Settings** tab. Add the new account's
> name/keyword to the row that matches how it appears in the export, or its
> transfers will be miscounted as income/expense:
>
> | Settings row | Covers |
> |--------------|--------|
> | **Your name (any spelling)** | every spelling of your name — for self-Zelle / Cash App moves; **any** one matching marks the row as your own transfer |
> | **Your handles & account numbers** | your own payment handles / identifiers (Cash App tag, Zelle email/phone, account last-4); merged with your name — any match = your own transfer |
> | **Own banks** + **Own bank rails** | your other linked banks (instant-payment moves) |
> | **Own sub-accounts** | your savings/checking sub-accounts |
> | **Own cards (rail-paid)** + **Card pay rails** | cards you pay via a labelled payment rail |
> | **Own card issuers (name-only)** | cards paid by an issuer-name-only outflow from checking |
> | **Lenders (loan in / repayment out)** | lenders you borrow from — deposits count as loan Income, payments as Expense |
>
> Add a value by typing it in the next empty cell on that row — no code editing.

### Optional: command-line converter (legacy)

A standalone Python version, `scripts/convert_everlance.py`, does the same
conversion outside the sheet (`python3 scripts/convert_everlance.py export.csv
out.csv`, then import the result at `Clean Transactions!A1`). The in-sheet importer is
the recommended path; the script is kept as a reference and for batch/CLI use.

## Roadmap (ideas for v2)

- A universal column-mapper: import *any* CSV by mapping its columns to the
  Transactions template (the profile engine is already built to accept it).
- More built-in bank/export profiles.
- Multi-currency support.

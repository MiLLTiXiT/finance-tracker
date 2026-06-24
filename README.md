# Finance Tracker (Google Sheets)

A personal finance tracker for Google Sheets. It comes in two forms:

1. **`sheets/finance-tracker-template.csv`** — a single-tab quick-start ledger
   you can import into Google Sheets in under a minute. Live formulas
   (running balance, totals, category breakdown) come along with the import.
2. **`apps-script/Code.gs`** — a Google Apps Script that builds the **full
   multi-tab tracker**: Transactions, an **Accounts** tab that turns opening
   balances into live per-account balances, a Dashboard with **weekly & monthly**
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
| **Transactions** | Ledger with category dropdown, **Account** and **Type** (Cash/Credit) columns, currency formatting and a guarded running-cumulative-net formula. Transfers between your own accounts carry the category **`Transfer`** so they move balances without distorting spend totals. A **filter** sits on the header — filter the **Account** column to one account (e.g. `Checking 3620`) to review it alone, and fix any row's **Category** by hand (the dropdown includes `Transfer`). Hand edits stick: re-importing never overwrites a row already in the sheet. |
| **Accounts** | One row per account (pre-seeded). Enter each **Opening Balance** — what it held before your first imported transaction; **credit cards are negative** (e.g. `-10000`). The **Current Balance** then derives automatically as *Opening + that account's income − expenses* (transfers included). |
| **Dashboard** | Three standing balances — **Cash on hand**, **Credit (debt)** and **Net worth (all)** — from the Accounts tab; all-time income/expense/net and **last 12 months / 12 weeks** summaries (transfers excluded); category spend-vs-budget for the current month (overspend highlighted). Plus three charts: **cashflow over time**, **category spend pie**, and **goals progress**. ⚠️ Until you set Opening Balances (below), the cash figure is labelled **"Net change since import"** — it's the change since your first import, *not* your real cash. |
| **Recurring** | Monthly recurring bills (name, category, amount, due day, active checkbox) with an annual projection and monthly/annual totals. |
| **Goals** | Savings/earnings goals (e.g. vacations): target amount & date, saved so far, monthly contribution, with computed remaining, % complete, months left and an on-track flag. |
| **Categories** | Edit this list to change the dropdown options and per-category monthly budgets used by the Dashboard. |
| **Settings** | Personal lists the CSV importer uses to recognise transfers between your own accounts (name, banks, cards). Edit a row to add an account — no code changes. |

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

## Importing transactions (built into the sheet)

The importer is **part of the Apps Script** — no Python, no command line, no
outside apps. You pick a CSV from a pop-up and it's cleaned and written straight
into the **Transactions** tab. Today it understands the
[Everlance](https://everlance.com) export format; it's built as a small registry
of **format profiles**, so more banks/exports can be added later without a
rewrite (Everlance is profile #1).

**First-time setup (once):**

1. Run **Finance ▸ Rebuild tracker** so all tabs exist — including the new
   **Settings** tab.
2. Open the **Settings** tab and fill in **Name tokens (ALL must match)** with
   distinctive parts of *your* name (use stems — e.g. `SMIT` matches both *Smith*
   and *Smithe* — so it reads correctly however the bank spells it). These let
   the importer spot *your* self-Zelle / Cash App transfers. The other rows start
   blank or with generic payment-rail keywords; add your own banks, sub-accounts
   and cards as your accounts require (see below).

**Each import (as often as you like — daily is fine):**

3. **Finance ▸ Import transactions (CSV)…** → a pop-up opens.
4. Choose your Everlance CSV export and click **Import**. Only transactions not
   already in the sheet are **added** (matched on a hidden `Ref` column); the
   summary shows how many were added vs. already present. The ledger re-sorts by
   date, the running **Balance** recomputes, and any new account/card is
   auto-added to the **Accounts** tab.
5. On the **Accounts** tab, fill each **Opening Balance** (what the account held
   before your first transaction; **credit cards negative**). The **Current
   Balance** and the Dashboard's Cash / Credit / Net-worth totals update
   automatically. *(One-time — opening balances stay put after this.)*

### What the importer does

- **splits the signed `Amount`** into Income/Expense;
- **tags each row with its Account and Type** — the bank account name (e.g.
  `Checking 1234`, `Visa Credit Card`) and whether it's `Cash` or `Credit`,
  so the **Accounts** tab can derive per-account balances;
- **keeps internal transfers but labels them `Transfer`** — masked-account moves,
  self-Zelle/Cash App, sub-account shuffles, and credit-card payments (BOTH legs:
  the money leaving checking *and* the matching "payment received" on the card,
  including payments labelled with only the issuer name — e.g. an issuer-named
  debit on checking paying that issuer's credit card). These move balances (paying a
  card lowers cash **and** card debt) but the Dashboard excludes the `Transfer`
  category from income/expense/spend totals, so nothing is double-counted.
  Purchases made **on** a card stay as ordinary expenses;
- **reconciles internal transfers the text rules miss** — money moved between
  your own accounts via a generic "DEPOSIT" or a person-name P2P has no transfer
  keyword, so it would be booked as **Income** where it lands, inflating that
  account. When an inflow in one account mirrors an outflow in another (same
  amount, within a few days), the importer pairs them and labels **both** legs
  `Transfer`. The summary reports how many it paired and flags any leftover
  transfer in/out **imbalance** — money whose matching leg is missing from the
  export, which may still be inflating an account's balance;
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

1. On the **Transactions** tab, click the filter on the **Account** header and
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
> | **Name tokens** | your name, for self-Zelle / Cash App moves |
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
out.csv`, then import the result at `Transactions!A1`). The in-sheet importer is
the recommended path; the script is kept as a reference and for batch/CLI use.

## Roadmap (ideas for v2)

- A universal column-mapper: import *any* CSV by mapping its columns to the
  Transactions template (the profile engine is already built to accept it).
- More built-in bank/export profiles.
- Multi-currency support.

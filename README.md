# Finance Tracker (Google Sheets)

A personal finance tracker for Google Sheets. It comes in two forms:

1. **`sheets/finance-tracker-template.csv`** — a single-tab quick-start ledger
   you can import into Google Sheets in under a minute. Live formulas
   (running balance, totals, category breakdown) come along with the import.
2. **`apps-script/Code.gs`** — a Google Apps Script that builds the **full
   multi-tab tracker**: Transactions, an **Accounts** tab that turns opening
   balances into live per-account balances, a Dashboard with **weekly & monthly**
   summaries plus **Cash / Credit / Net-worth** standing totals, **Recurring**
   monthly expenses, savings **Goals** (vacations, etc.), and a **Categories**
   config tab that drives dropdowns and budgets.

Use the CSV for an instant ledger, then run the Apps Script when you want the
full dashboards and extra tabs.

> **Live Sheet:** a ready-to-use copy has been created in Google Drive —
> [**Finance Tracker 2026**](https://docs.google.com/spreadsheets/d/1mQNsuWwPa6qXxPC8RyrkTNt5nX_E1BTq42tPbQhi7PU/edit)
> (owner: jamilwaliyy@gmail.com). Open it to start immediately, or follow the
> import steps below to make your own.

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

This creates all five tabs with formatting, dropdowns, checkboxes and the
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
| **Transactions** | Ledger with category dropdown, **Account** and **Type** (Cash/Credit) columns, currency formatting and a guarded running-cumulative-net formula. Transfers between your own accounts carry the category **`Transfer`** so they move balances without distorting spend totals. |
| **Accounts** | One row per account (pre-seeded). Enter each **Opening Balance** — what it held before your first imported transaction; **credit cards are negative** (e.g. `-10000`). The **Current Balance** then derives automatically as *Opening + that account's income − expenses* (transfers included). |
| **Dashboard** | Three standing balances — **Cash on hand**, **Credit (debt)** and **Net worth (all)** — from the Accounts tab; all-time income/expense/net and **last 12 months / 12 weeks** summaries (transfers excluded); category spend-vs-budget for the current month (overspend highlighted). Plus three charts: **cashflow over time**, **category spend pie**, and **goals progress**. |
| **Recurring** | Monthly recurring bills (name, category, amount, due day, active checkbox) with an annual projection and monthly/annual totals. |
| **Goals** | Savings/earnings goals (e.g. vacations): target amount & date, saved so far, monthly contribution, with computed remaining, % complete, months left and an on-track flag. |
| **Categories** | Edit this list to change the dropdown options and per-category monthly budgets used by the Dashboard. |

---

## Repo layout

```
finance-tracker/
├── README.md
├── sheets/
│   └── finance-tracker-template.csv   # importable single-tab ledger
├── scripts/
│   └── convert_everlance.py           # Everlance export -> Transactions CSV
└── apps-script/
    └── Code.gs                        # builds the full multi-tab tracker
```

## Importing an Everlance export

`scripts/convert_everlance.py` converts an [Everlance](https://everlance.com)
CSV export into the tracker's
`Date | Category | Description | Income | Expense | Account | Type` layout. It:

- splits the signed `Amount` into Income/Expense;
- **tags each row with its Account and Type** — the bank account name (e.g.
  `Checking 3620`, `Robinhood Credit Card`) and whether it's `Cash` or `Credit`,
  so the **Accounts** tab can derive per-account balances;
- **keeps internal transfers but labels them `Transfer`** — masked-account moves,
  self-Zelle/Cash App, Capital One 360 shuffles, and credit-card payments (BOTH
  legs: the money leaving checking *and* the matching "payment received" on the
  card, including payments labelled with only the issuer name — e.g. a "Robinhood"
  debit on checking paying the Robinhood Credit Card, see `OWN_CARD_ISSUERS`).
  These are needed so paying a card lowers cash **and** lowers card debt, but the
  Dashboard excludes the `Transfer` category from income/expense/spend totals so
  nothing is double-counted. Purchases made **on** a card stay as ordinary
  expenses;
- **removes exact-duplicate transactions** — if an account was synced twice, the
  same charge appears 2–3× with an identical bank reference; each real
  transaction is counted once (keyed on amount + date + merchant + bank
  description + account, ignoring tag/category columns);
- maps Everlance's ~70 categories down to the tracker's 10, and additionally
  classifies vaguely-labelled bank rows (e.g. "Debit") by **merchant keyword**
  (`MERCHANT_MAP`), so the GasBuddy fuel app lands in Transport instead of the
  catch-all "Other".

To classify more merchants, add `('KEYWORD', 'Category')` rows to
`MERCHANT_MAP` near the top of the script.

```bash
python3 scripts/convert_everlance.py everlance_export.csv transactions.csv
```

Then, in the multi-tab tracker:

1. Run **Finance ▸ Rebuild tracker** once so the Transactions tab has the
   `Account`/`Type`/`Balance` columns and the **Accounts** tab exists.
2. Select cell **A1** of the **Transactions** tab, then **File ▸ Import ▸
   Upload**, choose `transactions.csv`, and pick **"Replace data at selected
   cell"** (separator: comma; keep *Convert text to numbers/dates* ticked). This
   fills columns A–G; the `Balance` formula in column H recomputes on its own.
3. On the **Accounts** tab, fill each **Opening Balance** (what the account held
   before the first imported transaction; **credit cards negative**). The
   **Current Balance** and the Dashboard's Cash / Credit / Net-worth totals
   update automatically.

## Roadmap (ideas for v2)

- Charts on the Dashboard (cashflow over time, category pie).
- Multi-currency support.
- More bank/export formats for the import script.

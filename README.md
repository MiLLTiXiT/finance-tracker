# Finance Tracker (Google Sheets)

A personal finance tracker for Google Sheets. It comes in two forms:

1. **`sheets/finance-tracker-template.csv`** — a single-tab quick-start ledger
   you can import into Google Sheets in under a minute. Live formulas
   (running balance, totals, category breakdown) come along with the import.
2. **`apps-script/Code.gs`** — a Google Apps Script that builds the **full
   multi-tab tracker**: Transactions, a Dashboard with **weekly & monthly**
   summaries, **Recurring** monthly expenses, savings **Goals** (vacations,
   etc.), and a **Categories** config tab that drives dropdowns and budgets.

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
| **Transactions** | Ledger with category dropdown, currency formatting and a guarded running-balance formula. |
| **Dashboard** | All-time totals, **last 12 months** and **last 12 weeks** income/expense/net summaries, and category spend-vs-budget for the current month (overspend highlighted). |
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
└── apps-script/
    └── Code.gs                        # builds the full multi-tab tracker
```

## Roadmap (ideas for v2)

- Charts on the Dashboard (cashflow over time, category pie).
- Multi-currency support.
- Bank CSV import/normalisation into the Transactions tab.

/**
 * Finance Tracker — Google Apps Script builder
 * ------------------------------------------------------------------
 * Paste this into a Google Sheet (Extensions ▸ Apps Script), then run
 * `setup()` once. It (re)builds all tabs idempotently:
 *
 *   1. Clean Transactions — curated ledger with running balance + dropdowns
 *      (the SheetLink bank-feed add-on writes its RAW feed to a separate tab
 *      named "Transactions"; Sync from SheetLink cleans that into this ledger)
 *   2. Accounts          — opening balances -> live per-account balances
 *   3. Recurring         — monthly recurring expenses + annual projection
 *   4. Goals             — savings/earnings planning (vacations, etc.)
 *   5. Dashboard         — weekly AND monthly summaries + category spend
 *   6. Categories        — config feeding dropdowns & budgets
 *   7. Settings          — your name/banks/cards, read by the CSV importer
 *
 * Two ways to load transactions, both built in (no outside script):
 *   • Finance ▸ Sync from SheetLink — pulls the SheetLink bank-feed add-on's
 *     auto-synced tabs (transactions + real balances) into the ledger.
 *   • Finance ▸ Import transactions (CSV) — cleans an Everlance CSV export.
 * Both are INCREMENTAL: only transactions not already present are added (matched
 * on a hidden Ref column), so you can sync/import as often as you like — daily.
 *
 * Re-running setup() preserves any data already typed into the tabs
 * (it only rewrites headers, formulas, formatting and validation).
 */

// ---- Config -------------------------------------------------------
var SHEETS = {
  TX: 'Clean Transactions',
  // Our curated balances view. SheetLink hard-codes the tab name "Accounts" for
  // its own balance dump (just like it does "Transactions" for the raw feed), so
  // our summary lives on a separate tab it never writes to. See migrateAccountsTab_.
  ACCT: 'Account Summary',
  DASH: 'Dashboard',
  RECUR: 'Recurring',
  GOALS: 'Goals',
  CATS: 'Categories',
  SETTINGS: 'Settings'
};

var DEFAULT_CATEGORIES = [
  'Income', 'Housing', 'Groceries', 'Utilities', 'Dining',
  'Transport', 'Health', 'Entertainment', 'Savings', 'Other'
];

var CURRENCY = '"$"#,##0.00';
var TX_LAST_ROW = 1000; // formula range depth for the ledger

// ---- Menu ---------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finance')
    .addItem('Rebuild tracker (setup)', 'setup')
    .addItem('Sync from SheetLink (bank feed)', 'syncFromSheetLink')
    .addItem('Import transactions (CSV)…', 'importEverlanceCsv')
    .addSeparator()
    .addItem('About', 'about_')
    .addToUi();
}

function about_() {
  SpreadsheetApp.getUi().alert(
    'Finance Tracker',
    'Run "Rebuild tracker (setup)" to (re)create all tabs.\n' +
    'Your typed-in data is preserved; only headers, formulas and ' +
    'formatting are refreshed.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---- Entry point --------------------------------------------------
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  migrateAccountsTab_(ss);           // move our summary off the "Accounts" name SheetLink grabs
  var cats = buildCategories_(ss);   // build first; others reference it
  buildTransactions_(ss, cats);
  buildAccounts_(ss);                // opening balances -> current balances
  buildRecurring_(ss, cats);
  buildGoals_(ss);
  buildSettings_(ss);                // personal lists for the CSV importer
  buildDashboard_(ss, cats);
  buildCharts_(ss, cats);            // charts read from the Dashboard tables
  cleanupDefaultSheet_(ss);
  ss.setActiveSheet(ss.getSheetByName(SHEETS.DASH));
  SpreadsheetApp.getActive().toast('Finance Tracker is ready.', 'Done', 5);
}

// ---- Helpers ------------------------------------------------------
function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// One-time migration: earlier versions named our curated balances tab "Accounts",
// which is exactly the tab name SheetLink colonizes with its own balance dump. If a
// legacy "Accounts" tab exists and our new "Account Summary" tab doesn't yet:
//   - If it's a CLEAN curated tab (our headers, no SheetLink columns) → rename it so
//     any Opening Balances the user typed are preserved.
//   - If SheetLink already merged into it (has current_balance/last_synced_at columns)
//     → leave it for SheetLink; a fresh "Account Summary" is built and populated from
//     it by syncBalances_. (We never rename SheetLink's data onto our formula tab.)
function migrateAccountsTab_(ss) {
  var legacy = ss.getSheetByName('Accounts');
  if (!legacy || ss.getSheetByName(SHEETS.ACCT)) return;
  var ncol = Math.max(1, legacy.getLastColumn());
  var head = legacy.getRange(1, 1, 1, ncol).getValues()[0]
    .map(function (x) { return String(x).trim().toLowerCase(); });
  var colonized = head.indexOf('current_balance') !== -1 ||
                  head.indexOf('last_synced_at') !== -1 ||
                  head.indexOf('account_id') !== -1;
  if (!colonized) legacy.setName(SHEETS.ACCT);
}

function header_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#1f3864')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

// ---- 1. Categories (config) --------------------------------------
function buildCategories_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.CATS);
  header_(sheet, ['Category', 'Monthly Budget']);

  // Seed defaults only when the tab is empty (preserve user edits).
  if (sheet.getRange(2, 1).getValue() === '') {
    var seed = DEFAULT_CATEGORIES.map(function (c) {
      return [c, c === 'Income' ? '' : 0];
    });
    sheet.getRange(2, 1, seed.length, 2).setValues(seed);
  }
  sheet.getRange('B2:B').setNumberFormat(CURRENCY);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 140);

  // Return the current list of category names for dropdowns/budgets.
  var values = sheet.getRange('A2:A').getValues()
    .map(function (r) { return r[0]; })
    .filter(String);
  return values;
}

// ---- 2. Transactions ---------------------------------------------
function buildTransactions_(ss, cats) {
  var sheet = getOrCreate_(ss, SHEETS.TX);
  header_(sheet, ['Date', 'Category', 'Description', 'Income', 'Expense',
                  'Account', 'Type', 'Ref', 'Balance']);

  // Col H = Ref: each imported row's source identity, so the importer can add
  // ONLY transactions not already present (incremental import). Hidden — it's
  // bookkeeping, not for reading.
  //
  // Col I = Balance: running cumulative net, a global line across all accounts;
  // real per-account balances live on the Accounts tab. Rows are ordered newest
  // at the top, so the balance accumulates from the BOTTOM (oldest) up: each row =
  // the row below (next-older) + its own Income - Expense. The top row therefore
  // shows the current global net, like a bank statement. Guarded so empty rows
  // stay blank; N() on the below-reference treats an empty row as 0 so the chain
  // terminates cleanly at the data/empty boundary. The last template row is the
  // base case (prev = 0), which also avoids a #REF past the sheet's last row.
  var formulas = [];
  for (var r = 2; r <= TX_LAST_ROW; r++) {
    var prev = (r === TX_LAST_ROW) ? '0' : 'N(I' + (r + 1) + ')';
    formulas.push(['=IF(AND(D' + r + '="",E' + r + '=""),"",' +
      prev + '+N(D' + r + ')-N(E' + r + '))']);
  }
  sheet.getRange(2, 9, formulas.length, 1).setFormulas(formulas);

  // Formatting
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D2:E').setNumberFormat(CURRENCY);
  sheet.getRange('I2:I').setNumberFormat(CURRENCY);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(6, 175);
  sheet.hideColumns(8); // Ref — bookkeeping only

  // Category dropdown — include "Transfer" so imported transfer rows validate.
  applyCategoryValidation_(sheet, 'B2:B', cats.concat(['Transfer']));
  // Account Type dropdown (Cash / Credit).
  applyListValidation_(sheet, 'G2:G', ['Cash', 'Credit']);

  // Basic filter on the header so you can sort or filter the ledger by hand —
  // e.g. set the Account column to a single account (like "Checking 3620") to
  // review just those rows, then fix any Category yourself (set it to "Transfer"
  // to pull a row out of income/expense totals). Re-created idempotently.
  // The ledger is kept newest-at-top by the importer. Note: FILTERING (hiding
  // rows) leaves the running Balance intact; SORTING by hand physically reorders
  // rows, so the global Balance column reflows — re-run Finance ▸ Sync/Import (or
  // Rebuild) to restore the canonical newest-first order. Your edits are unaffected.
  var existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
  sheet.getRange(1, 1, TX_LAST_ROW, 9).createFilter();

  // Seed a couple of example rows when empty. They carry no Ref, so the first
  // import clears them (the tab is managed by the importer).
  if (sheet.getRange(2, 1).getValue() === '') {
    sheet.getRange(2, 1, 2, 7).setValues([
      [new Date(), 'Income', 'Salary', 3200, 0, 'Checking 1234', 'Cash'],
      [new Date(), 'Housing', 'Rent', 0, 1200, 'Checking 1234', 'Cash']
    ]);
  }
}

function applyCategoryValidation_(sheet, a1, cats) {
  applyListValidation_(sheet, a1, cats);
}

function applyListValidation_(sheet, a1, list) {
  if (!list.length) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(a1).setDataValidation(rule);
}

// ---- Account Summary (one real balance per account) ---------------
// Deliberately SIMPLE: three columns — Account | Type | Balance. Balance is the REAL
// balance from SheetLink's feed (filled by syncBalances_), credit cards as NEGATIVE
// (debt). The Dashboard's net worth is the sum of this column. We dropped the old
// transaction-derived "Current Balance"/Δ columns — with a real feed they were just a
// confusing second (and inaccurate) number next to the true one.
function buildAccounts_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.ACCT);
  // Clear any leftover columns from the old 6-column layout so no stale
  // "Current Balance"/"Bank Balance"/Δ values linger beside the new single column.
  if (sheet.getLastColumn() > 3) {
    sheet.getRange(1, 4, sheet.getMaxRows(), sheet.getLastColumn() - 3).clearContent()
      .clearFormat().clearDataValidations();
  }
  header_(sheet, ['Account', 'Type', 'Balance']);
  sheet.getRange('C1').setNote(
    'Balance is the REAL balance from the bank feed (filled by Finance ▸ Sync from ' +
    'SheetLink). Credit cards show as negative (debt). Net worth on the Dashboard is the ' +
    'sum of this column. Read-only — refreshed from the latest feed snapshot each sync.');
  sheet.getRange('C2:C').setNumberFormat(CURRENCY);
  applyListValidation_(sheet, 'B2:B', ['Cash', 'Credit']);

  // No example seed rows: real accounts are written here by syncBalances_ from the live
  // feed, and any ledger-only accounts (no feed balance) by syncAccountsFromTx_.
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 140);
}

// ---- 3. Recurring expenses ---------------------------------------
function buildRecurring_(ss, cats) {
  var sheet = getOrCreate_(ss, SHEETS.RECUR);
  header_(sheet, ['Name', 'Category', 'Amount', 'Due Day', 'Active', 'Annual']);

  // Annual projection: Amount * 12 when Active = TRUE.
  var formulas = [];
  for (var r = 2; r <= 200; r++) {
    formulas.push(['=IF(A' + r + '="","",IF(E' + r + '=TRUE,C' + r + '*12,0))']);
  }
  sheet.getRange(2, 6, formulas.length, 1).setFormulas(formulas);

  sheet.getRange('C2:C').setNumberFormat(CURRENCY);
  sheet.getRange('F2:F').setNumberFormat(CURRENCY);
  applyCategoryValidation_(sheet, 'B2:B', cats);

  // Active = checkbox
  sheet.getRange('E2:E').insertCheckboxes();

  // Totals row label + values just below a small block.
  sheet.getRange('H1').setValue('Monthly recurring total').setFontWeight('bold');
  sheet.getRange('I1').setFormula('=SUMIF(E2:E,TRUE,C2:C)').setNumberFormat(CURRENCY);
  sheet.getRange('H2').setValue('Annual recurring total').setFontWeight('bold');
  sheet.getRange('I2').setFormula('=SUM(F2:F)').setNumberFormat(CURRENCY);

  if (sheet.getRange(2, 1).getValue() === '') {
    sheet.getRange(2, 1, 3, 5).setValues([
      ['Rent', 'Housing', 1200, 1, true],
      ['Electricity', 'Utilities', 60, 9, true],
      ['Streaming', 'Entertainment', 15, 15, true]
    ]);
  }
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(8, 190);
}

// ---- 4. Goals (savings / earnings planning) ----------------------
function buildGoals_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.GOALS);
  header_(sheet, [
    'Goal', 'Target Amount', 'Target Date', 'Saved So Far',
    'Monthly Contribution', 'Remaining', '% Complete',
    'Months Left', 'On Track?'
  ]);

  for (var r = 2; r <= 100; r++) {
    // Remaining = Target - Saved
    var rem = '=IF(B' + r + '="","",MAX(0,B' + r + '-D' + r + '))';
    // % complete = Saved / Target
    var pct = '=IF(B' + r + '="","",IF(B' + r + '=0,0,MIN(1,D' + r + '/B' + r + ')))';
    // Months left until target date (from today)
    var months = '=IF(C' + r + '="","",DATEDIF(TODAY(),C' + r + ',"M"))';
    // On track? remaining can be covered by monthlyContribution * monthsLeft
    var onTrack = '=IF(OR(B' + r + '="",C' + r + '="",E' + r +
      '=""),"",IF(E' + r + '*H' + r + '>=F' + r + ',"Yes","No"))';
    sheet.getRange(r, 6).setFormula(rem);
    sheet.getRange(r, 7).setFormula(pct);
    sheet.getRange(r, 8).setFormula(months);
    sheet.getRange(r, 9).setFormula(onTrack);
  }

  sheet.getRange('B2:B').setNumberFormat(CURRENCY);
  sheet.getRange('C2:C').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D2:F').setNumberFormat(CURRENCY);
  sheet.getRange('G2:G').setNumberFormat('0%');

  // Highlight off-track goals.
  var rules = sheet.getConditionalFormatRules();
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('No')
    .setBackground('#f4cccc')
    .setRanges([sheet.getRange('I2:I')])
    .build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Yes')
    .setBackground('#d9ead3')
    .setRanges([sheet.getRange('I2:I')])
    .build());
  sheet.setConditionalFormatRules(rules);

  if (sheet.getRange(2, 1).getValue() === '') {
    var inSixMonths = new Date();
    inSixMonths.setMonth(inSixMonths.getMonth() + 6);
    sheet.getRange(2, 1, 1, 5).setValues([
      ['Vacation', 3000, inSixMonths, 600, 400]
    ]);
  }
  sheet.setColumnWidth(1, 160);
}

// ---- 5. Dashboard (weekly + monthly summaries) -------------------
function buildDashboard_(ss, cats) {
  var sheet = getOrCreate_(ss, SHEETS.DASH);
  sheet.clear();
  var tx = "'" + SHEETS.TX + "'";

  sheet.getRange('A1').setValue('Finance Dashboard')
    .setFontSize(16).setFontWeight('bold');

  // --- Spend totals (exclude transfers) ---
  var noXfer = ',' + tx + '!B2:B,"<>Transfer"';
  put_(sheet, 'A3', 'All-time Income', true);
  sheet.getRange('B3').setFormula('=SUMIFS(' + tx + '!D2:D' + noXfer + ')').setNumberFormat(CURRENCY);
  put_(sheet, 'A4', 'All-time Expense', true);
  sheet.getRange('B4').setFormula('=SUMIFS(' + tx + '!E2:E' + noXfer + ')').setNumberFormat(CURRENCY);
  put_(sheet, 'A5', 'Net', true);
  sheet.getRange('B5').setFormula('=B3-B4').setNumberFormat(CURRENCY);
  put_(sheet, 'A6', 'Monthly recurring', true);
  sheet.getRange('B6')
    .setFormula("=SUMIF('" + SHEETS.RECUR + "'!E2:E,TRUE,'" + SHEETS.RECUR + "'!C2:C)")
    .setNumberFormat(CURRENCY);

  // --- Standing balances by account group (from Account Summary) ---
  // Net worth is the sum of the real per-account Balance (col C) from the feed, so
  // credit-card debt counts even when a card's individual purchases aren't all synced.
  var acct = "'" + SHEETS.ACCT + "'";
  var bal = function (type) {
    return '=SUMIF(' + acct + '!B2:B,"' + type + '",' + acct + '!C2:C)';
  };
  sheet.getRange('D3').setFormula(
    '=IF(COUNT(' + acct + '!C2:C)=0,"Cash on hand (sync to fill) ⚠","Cash on hand")'
  ).setFontWeight('bold');
  sheet.getRange('D3').setNote(
    'Cash on hand = sum of the real Balance for your Cash accounts (from the feed). ' +
    'Run Finance ▸ Sync from SheetLink to fill the balances.');
  sheet.getRange('E3').setFormula(bal('Cash')).setNumberFormat(CURRENCY);
  put_(sheet, 'D4', 'Credit (debt)', true);
  sheet.getRange('E4').setFormula(bal('Credit')).setNumberFormat(CURRENCY);
  sheet.getRange('E4').setNote(
    'Total credit-card / loan debt — the real amount owed from the feed (negative). ' +
    'Subtracts from net worth.');
  put_(sheet, 'D5', 'Net worth (all)', true);
  sheet.getRange('E5').setFormula('=E3+E4').setNumberFormat(CURRENCY);

  // --- Monthly summary (last 12 months) ---
  put_(sheet, 'A9', 'Monthly Summary', true);
  sheet.getRange('A10:D10')
    .setValues([['Month', 'Income', 'Expense', 'Net']])
    .setFontWeight('bold').setBackground('#d9e1f2');
  for (var m = 0; m < 12; m++) {
    var row = 11 + m;
    // Month start = first day of (this month - (11-m)) so oldest is on top.
    var monthStart = '=EOMONTH(TODAY(),-' + (12 - m) + ')+1';
    sheet.getRange(row, 1).setFormula(monthStart).setNumberFormat('mmm yyyy');
    var ms = 'A' + row;                // month start cell
    var me = 'EOMONTH(A' + row + ',0)';// month end
    sheet.getRange(row, 2).setFormula(
      '=SUMIFS(' + tx + '!D2:D,' + tx + '!A2:A,">="&' + ms + ',' + tx + '!A2:A,"<="&' + me + noXfer + ')'
    ).setNumberFormat(CURRENCY);
    sheet.getRange(row, 3).setFormula(
      '=SUMIFS(' + tx + '!E2:E,' + tx + '!A2:A,">="&' + ms + ',' + tx + '!A2:A,"<="&' + me + noXfer + ')'
    ).setNumberFormat(CURRENCY);
    sheet.getRange(row, 4).setFormula('=B' + row + '-C' + row).setNumberFormat(CURRENCY);
  }

  // --- Weekly summary (last 12 weeks) ---
  put_(sheet, 'F9', 'Weekly Summary', true);
  sheet.getRange('F10:I10')
    .setValues([['Week Of', 'Income', 'Expense', 'Net']])
    .setFontWeight('bold').setBackground('#d9e1f2');
  for (var w = 0; w < 12; w++) {
    var wrow = 11 + w;
    // Week start (Monday) for (this week - (11-w)). Oldest on top.
    var weekStart = '=TODAY()-WEEKDAY(TODAY(),3)-' + (7 * (11 - w));
    sheet.getRange(wrow, 6).setFormula(weekStart).setNumberFormat('yyyy-mm-dd');
    var ws = 'F' + wrow;
    var we = 'F' + wrow + '+6';
    sheet.getRange(wrow, 7).setFormula(
      '=SUMIFS(' + tx + '!D2:D,' + tx + '!A2:A,">="&' + ws + ',' + tx + '!A2:A,"<="&' + we + noXfer + ')'
    ).setNumberFormat(CURRENCY);
    sheet.getRange(wrow, 8).setFormula(
      '=SUMIFS(' + tx + '!E2:E,' + tx + '!A2:A,">="&' + ws + ',' + tx + '!A2:A,"<="&' + we + noXfer + ')'
    ).setNumberFormat(CURRENCY);
    sheet.getRange(wrow, 9).setFormula('=G' + wrow + '-H' + wrow).setNumberFormat(CURRENCY);
  }

  // --- Category spend vs budget (this month) ---
  put_(sheet, 'A25', 'Category Spend — This Month', true);
  sheet.getRange('A26:D26')
    .setValues([['Category', 'Spent', 'Budget', 'Remaining']])
    .setFontWeight('bold').setBackground('#d9e1f2');
  var catsTab = "'" + SHEETS.CATS + "'";
  for (var i = 0; i < cats.length; i++) {
    var crow = 27 + i;
    var monthStart = '=EOMONTH(TODAY(),-1)+1';
    sheet.getRange(crow, 1).setValue(cats[i]);
    // Spent this month for this category
    sheet.getRange(crow, 2).setFormula(
      '=SUMIFS(' + tx + '!E2:E,' + tx + '!B2:B,A' + crow +
      ',' + tx + '!A2:A,">="&EOMONTH(TODAY(),-1)+1,' + tx + '!A2:A,"<="&EOMONTH(TODAY(),0))'
    ).setNumberFormat(CURRENCY);
    // Budget from Categories tab
    sheet.getRange(crow, 3).setFormula(
      '=IFERROR(VLOOKUP(A' + crow + ',' + catsTab + '!A:B,2,FALSE),0)'
    ).setNumberFormat(CURRENCY);
    sheet.getRange(crow, 4).setFormula('=C' + crow + '-B' + crow).setNumberFormat(CURRENCY);
  }

  // Highlight overspent categories (Remaining < 0).
  var dRules = sheet.getConditionalFormatRules();
  dRules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0)
    .setBackground('#f4cccc')
    .setRanges([sheet.getRange('D27:D' + (26 + cats.length))])
    .build());
  sheet.setConditionalFormatRules(dRules);

  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(6, 120);
  sheet.setFrozenRows(1);
}

function put_(sheet, a1, value, bold) {
  var r = sheet.getRange(a1).setValue(value);
  if (bold) r.setFontWeight('bold');
  return r;
}

// ---- Dashboard charts --------------------------------------------
// Idempotent: clears existing embedded charts on the Dashboard before
// re-inserting, so re-running setup() never stacks duplicates.
function buildCharts_(ss, cats) {
  var dash = ss.getSheetByName(SHEETS.DASH);
  if (!dash) return;
  dash.getCharts().forEach(function (c) { dash.removeChart(c); });

  var goals = ss.getSheetByName(SHEETS.GOALS);
  var catCount = Math.max(cats.length, 1);
  var catLast = 26 + catCount;       // category-spend table: rows 27..26+cats

  // 1. Cashflow over time — monthly summary table (Month | Income | Expense | Net).
  var cashflow = dash.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(dash.getRange('A10:D22'))
    .setPosition(40, 1, 0, 0)
    .setOption('title', 'Cashflow Over Time (Monthly)')
    .setOption('legend', { position: 'bottom' })
    .setNumHeaders(1)
    .build();
  dash.insertChart(cashflow);

  // 2. Category spend pie — this month's spend by category (Category + Spent).
  var pie = dash.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(dash.getRange('A26:B' + catLast))   // includes header row 26
    .setPosition(40, 6, 0, 0)
    .setOption('title', 'Category Spend — This Month')
    .setNumHeaders(1)
    .build();
  dash.insertChart(pie);

  // 3. Goals progress — % complete per goal (from the Goals tab).
  if (goals) {
    var progress = dash.newChart()
      .setChartType(Charts.ChartType.BAR)
      .addRange(goals.getRange('A1:A100'))   // goal names (header in A1)
      .addRange(goals.getRange('G1:G100'))   // % complete (header in G1)
      .setPosition(58, 1, 0, 0)
      .setOption('title', 'Goals Progress (% Complete)')
      .setNumHeaders(1)
      .setOption('hAxis', { format: 'percent' })
      .build();
    dash.insertChart(progress);
  }
}

// ==================================================================
//  CSV IMPORT — self-contained, no external tools
// ------------------------------------------------------------------
//  Finance ▸ Import transactions (CSV) opens a file picker, reads the
//  file in the browser, and hands the text to processImportedCsv().
//  A small "format profile" engine cleans it into the Transactions
//  layout. Everlance is profile #1; adding a new bank/format later is
//  just one more entry in PROFILES — no rewrite. The personal account
//  lists that drive transfer-detection live on the Settings tab, so
//  this script stays generic (your details aren't baked into the code).
// ==================================================================

// ---- Settings tab: personal lists the importer reads -------------
// Each row: col A = list name, cols B…→ = one value per cell. Add a
// value by typing in the next empty cell; the importer uppercases and
// trims on read. The seeds below are institution/keyword lists — they
// are NOT your name. The two identity rows ("Your name…" / "Your handles…")
// ship BLANK so a shared copy carries no one's personal details — each user
// types their own. They are the only own→own transfer signal (the feed never
// names the other side in a column, only in the description text).
var SETTINGS_ROWS = [
  ['Your name (any spelling)', [],
    'Type each way YOUR name appears in transactions, one per cell — e.g. JOHN, ' +
    'J SMITH, SMITH. A row whose description contains ANY of these is money moved ' +
    'between your own accounts (self Zelle/Cash App) → tagged Transfer. ' +
    'Matching is case-insensitive substring.'],
  ['Your handles & account numbers', [],
    'Your own payment handles / account identifiers: Cash App tag, Zelle email or ' +
    'phone, PayPal, account last-4 (e.g. 0864). One per cell. Same effect as your ' +
    'name — any match marks the row as your own transfer.'],
  ['Self P2P channels', ['ZELLE', 'PERSON-TO-PERSON', 'CASH APP', 'RTP'],
    'Instant-payment rails that, with your name, mean a self-transfer.'],
  ['Own banks', [],
    'Your other linked banks (movements to/from them are transfers). e.g. CHASE.'],
  ['Own bank rails', ['RTP', 'PERSON-TO-PERSON', 'INTERNET PAYMENT', 'ACCTVERIFY', 'TRANSFER'],
    'Rails that signal an own-bank movement.'],
  ['Own bank exclude', [],
    'Same-named merchants to NOT treat as your bank (e.g. a venue using the bank name).'],
  ['Own sub-accounts', [],
    'Your savings/checking sub-accounts (shuffles between them are transfers).'],
  ['Own cards (rail-paid)', [],
    'Cards you pay where the bank labels the outflow with a payment rail. e.g. VISA.'],
  ['Card pay rails', ['INTERNET PAYMENT', 'E-PAYMENT', 'EPAYMENT', 'ONLINE PAYMENT', 'AUTOPAY', 'BILL PAYMENT'],
    'Rails that indicate a credit-card payment.'],
  ['Own card issuers (name-only)', [],
    'Cards paid by an issuer-name-only outflow from checking (no rail in the text).'],
  ['Lenders (loan in / repayment out)', [],
    'Names of lenders you borrow from (e.g. a cash-advance/loan provider). A ' +
    'deposit from one is treated as loan Income; a payment to one as an Expense ' +
    '(category Other) — so repayments are not mis-filed under Housing, etc.'],
  ['SheetLink transactions tab', ['Transactions'],
    'Exact NAME of the tab the SheetLink bank-feed add-on writes transactions to. ' +
    'SheetLink always writes a tab named "Transactions" (it lets you pick the file, ' +
    'not the tab name), so that is the raw feed. Our curated ledger lives on the ' +
    'separate "Clean Transactions" tab; "Sync from SheetLink" reads this feed and ' +
    'writes the cleaned rows there. Case-sensitive.'],
  ['SheetLink accounts tab', ['(auto-detected)'],
    'No longer needed — Sync finds SheetLink\'s balance tab automatically by its ' +
    'columns and fills the Balance column on Account Summary. Left here for reference.'],
  ['SheetLink amount sign', ['out=positive'],
    'How the feed signs amounts. Plaid/SheetLink default is "out=positive" ' +
    '(money leaving = positive). If after a sync a DEPOSIT shows up as an ' +
    'Expense, change this to "in=positive" and sync again.'],
  ['Invert amount sign for (accounts)', ['DISCOVER'],
    'Account-name keywords whose amounts the feed signs BACKWARDS — a known Plaid ' +
    'quirk (Discover credit cards report the opposite sign to everything else). ' +
    'Any account whose name contains one of these has its amounts flipped, AFTER ' +
    'the global amount-sign toggle above. Substring, case-insensitive. Keep only ' +
    'accounts that actually show reversed (e.g. a purchase booked as Income) — ' +
    'remove DISCOVER if yours already imports correctly.']
];

// Single-value (scalar) Settings rows read raw (case preserved), separate from
// the uppercased keyword lists above. Used for the SheetLink integration.
var SETTINGS_SCALARS = [
  ['SheetLink transactions tab', 'Transactions'],
  ['SheetLink accounts tab', 'SheetLink Accounts'],
  ['SheetLink amount sign', 'out=positive']
];

// Map each Settings row label -> the cfg field the importer uses.
// Several labels intentionally map to 'identities' (your name + your handles are
// two input rows, plus legacy labels) — readSettings_ MERGES rows sharing a key.
var SETTINGS_KEYS = {
  'Your name (any spelling)': 'identities',
  'Your handles & account numbers': 'identities',
  'My identities (ANY match)': 'identities',       // legacy label → same cfg field
  'Name tokens (ALL must match)': 'identities',     // legacy label → same cfg field
  'Self P2P channels': 'selfChannels',
  'Own banks': 'ownBanks',
  'Own bank rails': 'ownBankRails',
  'Own bank exclude': 'ownBankExclude',
  'Own sub-accounts': 'own360',
  'Own cards (rail-paid)': 'ownCards',
  'Card pay rails': 'cardPayRails',
  'Own card issuers (name-only)': 'ownCardIssuers',
  'Lenders (loan in / repayment out)': 'lenders',
  'Invert amount sign for (accounts)': 'invertSignAccounts'
};

// Look up a SETTINGS_ROWS entry by its label → { vals, note } (empty if absent).
function settingsRow_(label) {
  for (var i = 0; i < SETTINGS_ROWS.length; i++) {
    if (SETTINGS_ROWS[i][0] === label) return { vals: SETTINGS_ROWS[i][1], note: SETTINGS_ROWS[i][2] };
  }
  return { vals: [], note: '' };
}

function buildSettings_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.SETTINGS);
  header_(sheet, ['Setting', 'Values (one per cell, add more to the right →)']);
  sheet.getRange('A1').setNote(
    'These lists let the CSV importer recognise transfers between your own ' +
    'accounts (so they move balances without distorting spend totals). ' +
    'Add a value by typing it in the next empty cell on that row.');

  // Seed missing rows (idempotent): append any SETTINGS_ROWS label not already
  // present, preserving existing user edits AND back-filling new settings (e.g.
  // the SheetLink rows) for sheets built before they existed.
  var lastRow = sheet.getLastRow();
  var have = {};
  if (lastRow >= 2) {
    var labels = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var h = 0; h < labels.length; h++) {
      var L = String(labels[h][0]).trim();
      if (L) have[L] = true;
      // Migrate a legacy identity row in place to the new "Your name (any spelling)"
      // label, preserving any tokens the user already typed. Covers both the original
      // "Name tokens (ALL must match)" and the interim "My identities (ANY match)".
      // The new label seeds BLANK, so the user's values are never overwritten and no
      // personal name is re-introduced; the separate "Your handles & account numbers"
      // row is absent on old sheets and gets appended blank by the seeder below.
      if (L === 'Name tokens (ALL must match)' || L === 'My identities (ANY match)') {
        var newRow = settingsRow_('Your name (any spelling)');   // {vals, note}
        var rowNum = h + 2;
        sheet.getRange(rowNum, 1).setValue('Your name (any spelling)').setNote(newRow.note);
        have['Your name (any spelling)'] = true;
      }
    }
  }
  var nextRow = Math.max(lastRow, 1) + 1;
  for (var i = 0; i < SETTINGS_ROWS.length; i++) {
    var label = SETTINGS_ROWS[i][0];
    if (have[label]) continue;
    var vals = SETTINGS_ROWS[i][1];
    var note = SETTINGS_ROWS[i][2];
    sheet.getRange(nextRow, 1).setValue(label).setNote(note);
    if (vals.length) sheet.getRange(nextRow, 2, 1, vals.length).setValues([vals]);
    nextRow++;
  }
  sheet.setColumnWidth(1, 230);
  sheet.setFrozenColumns(1);
}

// Read the Settings tab into a cfg object. Missing/blank rows fall back
// to DEFAULT_CFG. Identities fall back to [] here; the actual seed lives in
// SETTINGS_ROWS and is written to (and editable on) the Settings tab.
function readSettings_(ss) {
  var cfg = {
    identities: [],
    selfChannels: ['ZELLE', 'PERSON-TO-PERSON', 'CASH APP', 'RTP'],
    ownBanks: [],
    ownBankRails: ['RTP', 'PERSON-TO-PERSON', 'INTERNET PAYMENT', 'ACCTVERIFY', 'TRANSFER'],
    ownBankExclude: [],
    own360: [],
    ownCards: [],
    cardPayRails: ['INTERNET PAYMENT', 'E-PAYMENT', 'EPAYMENT', 'ONLINE PAYMENT', 'AUTOPAY', 'BILL PAYMENT'],
    ownCardIssuers: [],
    lenders: [],
    invertSignAccounts: []
  };
  var sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) return cfg;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var seen = {};   // keys already populated by a Settings row in THIS pass
  for (var i = 0; i < data.length; i++) {
    var label = String(data[i][0]).trim();
    var key = SETTINGS_KEYS[label];
    if (!key) continue;
    var vals = [];
    for (var c = 1; c < data[i].length; c++) {
      var v = String(data[i][c]).trim();
      if (v) vals.push(v.toUpperCase());
    }
    // First row for a key REPLACES the built-in default (even when empty); later
    // rows mapping to the same key (e.g. name + handles → identities) MERGE in.
    if (seen[key]) cfg[key] = cfg[key].concat(vals);
    else { cfg[key] = vals; seen[key] = true; }
  }
  for (var k in seen) { if (seen.hasOwnProperty(k)) cfg[k] = dedupe_(cfg[k]); }
  return cfg;
}

// Case-sensitive de-dup preserving first-seen order (values are already uppercased).
function dedupe_(arr) {
  var out = [], have = {};
  for (var i = 0; i < arr.length; i++) {
    if (!have[arr[i]]) { have[arr[i]] = true; out.push(arr[i]); }
  }
  return out;
}

// ---- Format-profile engine (built to extend) ---------------------
// Add a new bank/format by pushing another {name, detect, parse} here.
var PROFILES = [{
  name: 'Everlance',
  detect: function (values) { return everlanceHeaderRow_(values) !== -1; },
  parse: function (values, cfg) { return parseEverlance_(values, cfg); }
}, {
  name: 'SheetLink',
  detect: function (values) { return sheetLinkHeader_(values) !== null; },
  parse: function (values, cfg) { return parseSheetLink_(values, cfg); }
}];

function pickProfile_(values) {
  for (var i = 0; i < PROFILES.length; i++) {
    if (PROFILES[i].detect(values)) return PROFILES[i];
  }
  throw new Error('Unrecognised CSV format (no matching import profile).');
}

// ---- Everlance taxonomy (format-specific, not personal) ----------
var EV_CATEGORY_MAP = {
  'Payroll': 'Income', 'Revenue': 'Income', 'Interest Earned': 'Income',
  'Deposit': 'Income',
  'Gas Stations': 'Transport', 'Gasoline': 'Transport', 'Tolls and Fees': 'Transport',
  'Car Dealers and Leasing': 'Transport', 'Car and Truck Rentals': 'Transport',
  'Car Wash and Detail': 'Transport', 'Other Vehicle Related Expenses': 'Transport',
  'Maintenance and Repair': 'Transport', 'Shipping and Freight': 'Transport',
  'Restaurants': 'Dining', 'Fast Food': 'Dining', 'Food and Beverage': 'Dining',
  'Business Meals & Entertainment': 'Dining',
  'Supermarkets and Groceries': 'Groceries', 'Food and Beverage Store': 'Groceries',
  'Convenience Stores': 'Groceries', 'Warehouses and Wholesale Stores': 'Groceries',
  'Telecommunication Services': 'Utilities', 'Insurance': 'Utilities',
  'Lodging': 'Housing', 'Loans and Mortgages': 'Housing', 'Storage': 'Housing',
  'Hardware Store': 'Housing',
  'Pharmacies': 'Health', 'Dentists': 'Health', 'Glasses and Optometrist': 'Health',
  'Personal Care': 'Health', 'Gyms and Fitness Centers': 'Health',
  'Arts and Entertainment': 'Entertainment', 'Recreation': 'Entertainment',
  'Subscription': 'Entertainment', 'Digital Purchase': 'Entertainment',
  'Computers and Electronics': 'Entertainment', 'Tobacco': 'Entertainment',
  'Stock Brokers': 'Savings'
};
var EV_GENERIC = ['Credit', 'Debit', 'Withdrawal', 'Payment', 'Credit Card', 'Banking and Finance'];
// Merchant keyword -> category, for vague bank rows (e.g. GasBuddy labelled "Debit").
var EV_MERCHANT_MAP = [
  ['GASBUDDY', 'Transport'], ['EZPASS', 'Transport'], ['EZ PASS', 'Transport'],
  ['E-ZPASS', 'Transport'], ['ETOLL', 'Transport'], ['E-TOLL', 'Transport'],
  ['ETOLLAVIS', 'Transport'], ['MARYLAND MVA', 'Transport']
];
var EV_MASKED_XFER = /(TO|FROM)\s+\*+\s*\d{3,}/i;
var EV_CARD_PAY_MARKERS = ['THANK YOU', 'INTERNET PAYMENT', 'AUTOPAY'];
var EV_CARD_REWARD_MARKERS = ['STATEMENT CREDIT', 'CASHBACK', 'POINTS', 'REDEMPTION', 'REWARD'];

function anyIn_(t, list) {
  for (var i = 0; i < list.length; i++) { if (t.indexOf(list[i]) !== -1) return true; }
  return false;
}
function round2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function money_(s) {
  s = String(s).trim().replace(/\$/g, '').replace(/,/g, '');
  if (s === '' || s === '-') return 0.0;
  var neg = s.charAt(0) === '-';
  if (neg) s = s.replace(/^-+/, '');
  var v = parseFloat(s);
  if (isNaN(v)) v = 0.0;
  return neg ? -v : v;
}

function mapCategory_(ecat, merch, isIncome, cfg) {
  var m = String(merch).toUpperCase();
  // A check/money order YOU write is an expense; a check you DEPOSIT is income.
  // Everlance tags both 'Check', so direction (not the label) decides.
  if (ecat === 'Check') return isIncome ? 'Income' : 'Other';
  // Lenders (configured on the Settings tab): a deposit is a loan (income) and a
  // payment is a repayment (expense) — so neither is mis-bucketed (e.g. the
  // 'Loans and Mortgages' tag would otherwise push repayments into Housing).
  if (cfg && cfg.lenders) {
    for (var k = 0; k < cfg.lenders.length; k++) {
      if (cfg.lenders[k] && m.indexOf(cfg.lenders[k]) !== -1) return isIncome ? 'Income' : 'Other';
    }
  }
  for (var i = 0; i < EV_MERCHANT_MAP.length; i++) {
    if (m.indexOf(EV_MERCHANT_MAP[i][0]) !== -1) return EV_MERCHANT_MAP[i][1];
  }
  if (EV_CATEGORY_MAP.hasOwnProperty(ecat)) return EV_CATEGORY_MAP[ecat];
  if (EV_GENERIC.indexOf(ecat) !== -1) return isIncome ? 'Income' : 'Other';
  return isIncome ? 'Income' : 'Other';
}

function isTransfer_(text, cfg) {
  var t = String(text).toUpperCase();
  if (EV_MASKED_XFER.test(t)) return true;
  if (t.indexOf('ONLINE TRANSFER') !== -1 || t.indexOf('DEPOSIT TRANSFER') !== -1) return true;
  // Identity match: a row whose description names YOU (any spelling of your name or
  // your own handles, e.g. a Cash App tag) is money moved between your own accounts.
  // The feed never names the other side in a column — only in the description text —
  // so this name match is the only reliable own->own signal. ANY token is enough
  // (your name appears in different spellings on different rows).
  if (cfg.identities.length && anyIn_(t, cfg.identities)) return true;
  if (anyIn_(t, cfg.ownBanks) && !anyIn_(t, cfg.ownBankExclude) && anyIn_(t, cfg.ownBankRails)) return true;
  if (anyIn_(t, cfg.own360)) return true;
  if (anyIn_(t, cfg.ownCards) && anyIn_(t, cfg.cardPayRails)) return true;
  return false;
}

function isCardPayment_(account, amount, merch, bankdesc, ecat, cfg) {
  var acct = String(account).toUpperCase();
  var t = (String(merch) + ' ' + String(bankdesc)).toUpperCase();
  // Checking-side leg: outflow to an issuer the holder pays directly (name-only).
  if (acct.indexOf('CARD') === -1 && amount < 0 && anyIn_(t, cfg.ownCardIssuers)) return true;
  if (acct.indexOf('CARD') === -1) return false;
  if (amount <= 0) return false;                 // a purchase on the card = real expense
  if (anyIn_(t, EV_CARD_REWARD_MARKERS)) return false; // cashback / statement credit = keep
  if (anyIn_(t, EV_CARD_PAY_MARKERS)) return true;
  if (String(ecat).trim() === 'Credit Card' &&
      ['PAYMENT', 'INTERNET PAYMENT'].indexOf(String(merch).trim().toUpperCase()) !== -1) return true;
  return false;
}

// Internal-transfer detection is handled per row by isTransfer_ (it matches your
// identity in the description). Money moved between your own accounts is tagged
// 'Transfer' when the row names you; there is no amount/sum-based leg pairing —
// it matched coincidentally-equal cross-account transactions and the user asked to
// classify only by who the other party is, not by matching amounts.

function everlanceHeaderRow_(values) {
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (r[0] === 'Amount' && r[1] === 'Date' && r[2] === 'Merchant' && r[3] === 'Category') return i;
  }
  return -1;
}

// Core Everlance -> Transactions conversion. Mirrors scripts/convert_everlance.py
// (verified row-for-row against it). Returns {rows, stats}; dates stay as
// 'YYYY-MM-DD' strings here and become real Dates in writeTransactions_.
function parseEverlance_(values, cfg) {
  var hi = everlanceHeaderRow_(values);
  if (hi === -1) throw new Error('Not an Everlance export (header row not found).');
  var out = [];
  var dupes = 0;
  var seen = {};
  for (var j = hi + 1; j < values.length; j++) {
    var r = values[j];
    if (r.length < 4 || !String(r[1]).trim()) continue;
    var amt = money_(r[0]);
    var date = String(r[1]).trim();
    var merch = String(r[2]).trim();
    var bd = r.length > 8 ? String(r[8]).trim() : '';
    var ac = r.length > 9 ? String(r[9]).trim() : '';
    var key = round2_(amt) + '|' + date + '|' + merch.toUpperCase() + '|' +
              bd.toUpperCase() + '|' + ac.toUpperCase();
    if (seen[key]) { dupes++; continue; }
    seen[key] = true;
    var ecat = String(r[3]).trim() || 'Uncategorized';
    var acct = ac.split(' - ')[0].trim();
    var atype = ac.toUpperCase().indexOf('CARD') !== -1 ? 'Credit' : 'Cash';
    var cat;
    if (isTransfer_(merch + ' ' + bd, cfg) || isCardPayment_(ac, amt, merch, bd, ecat, cfg)) {
      cat = 'Transfer';
    } else {
      cat = mapCategory_(ecat, merch, amt > 0, cfg);
    }
    var inc = amt > 0 ? round2_(amt) : '';
    var exp = amt < 0 ? round2_(-amt) : '';
    // 8th field = Ref (the dedupe key) so the importer can match against rows
    // already in the sheet and add only what's new.
    out.push([date, cat, merch, inc, exp, acct, atype, key]);
  }
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  // Tally so income/expense exclude every transfer; the transfer in/out imbalance
  // is reported for auditing (a non-zero imbalance flags one-sided/missing legs).
  var stats = { kept: out.length, transfers: 0, dupes: dupes,
                income: 0.0, expense: 0.0, xferIn: 0.0, xferOut: 0.0 };
  for (var s = 0; s < out.length; s++) {
    var row = out[s];
    var ii = (row[3] === '' || row[3] === null) ? 0 : Number(row[3]);
    var ee = (row[4] === '' || row[4] === null) ? 0 : Number(row[4]);
    if (row[1] === 'Transfer') {
      stats.transfers++;
      stats.xferIn = round2_(stats.xferIn + ii);
      stats.xferOut = round2_(stats.xferOut + ee);
    } else {
      stats.income = round2_(stats.income + ii);
      stats.expense = round2_(stats.expense + ee);
    }
  }
  return { rows: out, stats: stats };
}

// ==================================================================
//  SheetLink bank-feed profile + sync
// ------------------------------------------------------------------
//  The SheetLink add-on auto-writes bank transactions (and balances)
//  into tabs of this spreadsheet on a schedule (Plaid under the hood).
//  parseSheetLink_ normalizes that feed into our Transactions layout,
//  using the stable Plaid transaction_id as the dedupe Ref. Transfer
//  detection, category mapping and cross-account pairing are reused
//  from the Everlance path, so own-account moves are tagged Transfer.
// ==================================================================

// Plaid personal-finance-category (primary) -> our 10 categories.
var PLAID_CAT_MAP = {
  'INCOME': 'Income',
  'TRANSPORTATION': 'Transport', 'TRAVEL': 'Transport',
  'RENT_AND_UTILITIES': 'Utilities',
  'HOME_IMPROVEMENT': 'Housing',
  'MEDICAL': 'Health', 'PERSONAL_CARE': 'Health',
  'ENTERTAINMENT': 'Entertainment',
  'GENERAL_MERCHANDISE': 'Other', 'GENERAL_SERVICES': 'Other',
  'GOVERNMENT_AND_NON_PROFIT': 'Other', 'LOAN_PAYMENTS': 'Other',
  'BANK_FEES': 'Other'
};

function mapPlaidCategory_(catStr, subStr, merch, isIncome) {
  var m = String(merch).toUpperCase();
  for (var i = 0; i < EV_MERCHANT_MAP.length; i++) {       // GasBuddy/EZPass etc.
    if (m.indexOf(EV_MERCHANT_MAP[i][0]) !== -1) return EV_MERCHANT_MAP[i][1];
  }
  var c = String(catStr).toUpperCase();
  var sub = String(subStr).toUpperCase();
  if (c.indexOf('INCOME') !== -1) return 'Income';
  if (c.indexOf('FOOD_AND_DRINK') !== -1)
    return sub.indexOf('GROCER') !== -1 ? 'Groceries' : 'Dining';
  if (c.indexOf('RENT_AND_UTIL') !== -1)
    return sub.indexOf('RENT') !== -1 ? 'Housing' : 'Utilities';
  for (var key in PLAID_CAT_MAP) {
    if (PLAID_CAT_MAP.hasOwnProperty(key) && c.indexOf(key) !== -1) return PLAID_CAT_MAP[key];
  }
  return isIncome ? 'Income' : 'Other';
}

// Locate the SheetLink header row + a field -> column-index map. SheetLink can
// write a 5-, 18- or 35-column layout, so map by header NAME (lowercased).
// Returns {row, idx:{...}} or null. Requires date+amount plus a SheetLink-
// distinctive column, so it never matches an Everlance file ('Amount','Date'…).
function sheetLinkHeader_(values) {
  var alias = {
    date: ['date', 'authorized_date', 'transaction_date', 'posted'],
    amount: ['amount'],
    name: ['name', 'description', 'description_raw', 'original_description', 'transaction_name'],
    merchant: ['merchant_name', 'merchant'],
    account: ['account_name', 'account'],
    accountType: ['account_type', 'type'],
    category: ['category', 'category_primary', 'personal_finance_category', 'primary_category'],
    subcategory: ['subcategory', 'category_detailed', 'detailed_category'],
    ref: ['transaction_id', 'id'],
    pending: ['pending']
  };
  for (var i = 0; i < Math.min(values.length, 15); i++) {
    var row = values[i];
    if (!row || row.length < 2) continue;
    var lc = {};
    for (var c = 0; c < row.length; c++) {
      var h = String(row[c]).trim().toLowerCase();
      if (h && !(h in lc)) lc[h] = c;
    }
    var idx = {};
    for (var field in alias) {
      if (!alias.hasOwnProperty(field)) continue;
      idx[field] = -1;
      for (var a = 0; a < alias[field].length; a++) {
        if (alias[field][a] in lc) { idx[field] = lc[alias[field][a]]; break; }
      }
    }
    // Distinctive columns that SheetLink has but an Everlance export does not —
    // its snake_case ids (account_name/merchant_name/transaction_id/account_id)
    // or its minimal-mode bare 'account'/'description'. Everlance uses 'Merchant'
    // and prefixed 'Bank Account'/'Bank Description', so it never matches here.
    var distinctive = idx.ref !== -1 || ('account_name' in lc) || ('merchant_name' in lc) ||
                      ('account_id' in lc) || ('description' in lc) || ('account' in lc);
    if (idx.date !== -1 && idx.amount !== -1 && distinctive) return { row: i, idx: idx };
  }
  return null;
}

// Format a date cell (a Date from a sheet, or a string) to 'YYYY-MM-DD' so it
// flows through writeTransactions_ exactly like the Everlance path.
function toYmd_(v) {
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) +
           '-' + ('0' + v.getDate()).slice(-2);
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);          // ISO 'YYYY-MM-DD…'
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);                                  // fallback ('MM/DD/YYYY' etc.)
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
           '-' + ('0' + d.getDate()).slice(-2);
  }
  return s;
}

function isTrue_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

// Parse SheetLink feed rows into [date,cat,desc,inc,exp,acct,type,ref] + stats.
// cfg.slOutPositive controls the amount sign (Plaid default: out=positive).
function parseSheetLink_(values, cfg) {
  var hdr = sheetLinkHeader_(values);
  if (!hdr) throw new Error('No SheetLink data found (header row not recognised).');
  var ix = hdr.idx;
  var outPositive = !(cfg && cfg.slOutPositive === false);   // default true
  var inSign = outPositive ? -1 : 1;          // amount * inSign = money-IN value (+)
  var out = [];
  var dupes = 0, pendingSkipped = 0;
  var seen = {};
  for (var j = hdr.row + 1; j < values.length; j++) {
    var r = values[j];
    if (!r) continue;
    var get = function (k) { return (ix[k] !== -1 && ix[k] < r.length) ? r[ix[k]] : ''; };
    var rawDate = get('date');
    if (rawDate === '' || rawDate === null) continue;        // blank/spacer row
    if (ix.pending !== -1 && isTrue_(get('pending'))) { pendingSkipped++; continue; }
    var amt = money_(get('amount'));
    var inflow = round2_(inSign * amt);                      // + = money in
    var name = String(get('name')).trim();
    var merch = String(get('merchant')).trim() || name;
    var account = cleanAcctName_(get('account')) || 'Unknown';
    // Some institutions (e.g. Discover) sign amounts BACKWARDS vs the rest of the
    // feed, so a purchase would land as Income. Flip such accounts after the global
    // toggle — see the "Invert amount sign for (accounts)" Settings row.
    if (cfg.invertSignAccounts && cfg.invertSignAccounts.length &&
        anyIn_(account.toUpperCase(), cfg.invertSignAccounts)) {
      inflow = round2_(-inflow);
    }
    var atypeRaw = String(get('accountType')).trim().toLowerCase();
    var atype = (atypeRaw.indexOf('credit') !== -1 || atypeRaw.indexOf('loan') !== -1) ? 'Credit' : 'Cash';
    var date = toYmd_(rawDate);
    var refRaw = String(get('ref')).trim();
    // Stable Plaid id is the ideal Ref; fall back to a composed key if absent.
    var ref = refRaw ? 'SL:' + refRaw
      : 'SL:' + date + '|' + round2_(amt) + '|' + merch.toUpperCase() + '|' + account.toUpperCase();
    if (seen[ref]) { dupes++; continue; }                   // in-feed duplicate
    seen[ref] = true;
    var isIncome = inflow > 0;
    var cat;
    // isCardPayment_ uses the money-IN-positive convention (like Everlance amt).
    if (isTransfer_(merch + ' ' + name, cfg) || isCardPayment_(account, inflow, merch, name, '', cfg)) {
      cat = 'Transfer';
    } else {
      cat = mapPlaidCategory_(get('category'), get('subcategory'), merch, isIncome);
    }
    var inc = inflow > 0 ? inflow : '';
    var exp = inflow < 0 ? round2_(-inflow) : '';
    out.push([date, cat, merch, inc, exp, account, atype, ref]);
  }
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  var stats = { kept: out.length, transfers: 0, dupes: dupes,
                pendingSkipped: pendingSkipped, income: 0.0, expense: 0.0,
                xferIn: 0.0, xferOut: 0.0 };
  for (var s = 0; s < out.length; s++) {
    var row = out[s];
    var ii = (row[3] === '' || row[3] === null) ? 0 : Number(row[3]);
    var ee = (row[4] === '' || row[4] === null) ? 0 : Number(row[4]);
    if (row[1] === 'Transfer') {
      stats.transfers++;
      stats.xferIn = round2_(stats.xferIn + ii);
      stats.xferOut = round2_(stats.xferOut + ee);
    } else {
      stats.income = round2_(stats.income + ii);
      stats.expense = round2_(stats.expense + ee);
    }
  }
  return { rows: out, stats: stats };
}

// ---- SheetLink settings (scalars) + sync handlers ----------------
// Read a single-value Setting (case preserved, unlike the keyword lists).
function rawSetting_(ss, label) {
  var sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return '';
  var lastCol = Math.max(2, sheet.getLastColumn());
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === label) {
      for (var c = 1; c < data[i].length; c++) {
        var v = String(data[i][c]).trim();
        if (v) return v;
      }
      return '';
    }
  }
  return '';
}

function readSheetLinkCfg_(ss) {
  var sign = rawSetting_(ss, 'SheetLink amount sign').toUpperCase();
  return {
    txTab: rawSetting_(ss, 'SheetLink transactions tab') || 'Transactions',
    acctTab: rawSetting_(ss, 'SheetLink accounts tab'),
    // Default Plaid convention out=positive; only an explicit "in=positive" flips.
    outPositive: sign.indexOf('IN=POS') === -1
  };
}

function firstCol_(head, names) {
  for (var i = 0; i < names.length; i++) { if (names[i] in head) return head[names[i]]; }
  return -1;
}

// Strip redundant masked tails from an account label so the feed's
// "Checking 3620 ••••3620" / "Robinhood Credit Card **5254 ••••5254" /
// "EVERYDAY CHECKING ...3754" collapse to a single clean name. Removes one or more
// trailing "<mask chars><digits>" groups (••••, ****, ..., ·, etc.). The real
// account number already embedded in the name (e.g. "Checking 3620") is kept.
function cleanAcctName_(name) {
  var s = String(name == null ? '' : name).trim();
  var prev;
  do {
    prev = s;
    s = s.replace(/[\s\-]*(?:[•*·.]{2,}|x)\s*\d{3,5}\s*$/i, '').trim();
  } while (s !== prev && s !== '');
  return s || String(name == null ? '' : name).trim();
}

// Find SheetLink's accounts/balances tab by signature columns (it carries
// current_balance + a sync timestamp / subtype / account_id), wherever SheetLink
// wrote it — robust to whatever name it uses. Skips our own tracker tabs.
function findBalancesSheet_(ss) {
  var known = {};
  for (var k in SHEETS) { if (SHEETS.hasOwnProperty(k)) known[SHEETS[k]] = true; }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (known[sh.getName()] || sh.getLastRow() < 1) continue;
    var ncol = Math.min(sh.getLastColumn(), 40);
    var head = sh.getRange(1, 1, 1, ncol).getValues()[0]
      .map(function (x) { return String(x).trim().toLowerCase(); });
    if (head.indexOf('current_balance') !== -1 &&
        (head.indexOf('last_synced_at') !== -1 || head.indexOf('subtype') !== -1 ||
         head.indexOf('account_id') !== -1)) {
      return sh;
    }
  }
  return null;
}

// Resolve a human account name from a balance row. Uses the header-named column when
// present; otherwise (legacy tab where SheetLink's name landed under one of OUR
// headers) falls back to the leftmost cell that looks like a name — not a Plaid id,
// number, currency, timestamp, or a bare type/subtype word.
function balanceName_(row, nameCol) {
  if (nameCol !== -1) {
    var n = String(row[nameCol]).trim();
    if (n) return n;
  }
  for (var c = 0; c < row.length; c++) {
    var v = String(row[c]).trim();
    if (!v) continue;
    if (/^[A-Za-z0-9]{20,}$/.test(v)) continue;              // Plaid account_id
    if (/^[-$\d.,%()\s]+$/.test(v)) continue;                // number / currency
    if (/^\d{4}-\d\d-\d\dt/i.test(v)) continue;              // ISO timestamp
    if (/^(cash|credit|checking|savings|credit card|loan|brokerage|crypto( exchange)?|depository|money market)$/i.test(v)) continue;
    return v;
  }
  return '';
}

// Delete SheetLink's STALE balance snapshots in place: SheetLink appends a fresh full
// copy of every account on each sync (keyed by last_synced_at) and never removes the
// old ones, so the tab grows without bound. Keep header + rows from the most recent
// sync (rows that actually carry a balance); drop everything older. Returns kept count.
function trimBalancesSnapshot_(sheet, tsCol, balCol) {
  var vals = sheet.getDataRange().getValues();
  if (vals.length < 2) return 0;
  var latest = '';
  if (tsCol !== -1) {
    for (var i = 1; i < vals.length; i++) {
      var t = String(vals[i][tsCol]).trim();
      if (t > latest) latest = t;
    }
  }
  var keep = [vals[0]];
  for (var j = 1; j < vals.length; j++) {
    var hasBal = balCol !== -1 && String(vals[j][balCol]).trim() !== '';
    var tsOk = (tsCol === -1) || (String(vals[j][tsCol]).trim() === latest);
    if (hasBal && tsOk) keep.push(vals[j]);
  }
  if (keep.length === vals.length) return keep.length - 1;   // nothing stale
  sheet.clearContents();
  sheet.getRange(1, 1, keep.length, keep[0].length).setValues(keep);
  return keep.length - 1;
}

// Find the SheetLink transactions sheet: try the configured name, else scan all
// non-tracker sheets for one whose header looks like a SheetLink feed.
function findSheetLinkSheet_(ss, configuredName) {
  if (configuredName) {
    var byName = ss.getSheetByName(configuredName);
    if (byName) return byName;
  }
  var known = {};
  for (var k in SHEETS) { if (SHEETS.hasOwnProperty(k)) known[SHEETS[k]] = true; }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (known[sheets[i].getName()] || sheets[i].getLastRow() < 1) continue;
    var probe = sheets[i].getRange(1, 1, Math.min(sheets[i].getLastRow(), 12),
      Math.min(sheets[i].getLastColumn(), 40)).getValues();
    if (sheetLinkHeader_(probe)) return sheets[i];
  }
  return null;
}

// Menu handler: pull the SheetLink feed into our ledger + sync bank balances.
function syncFromSheetLink() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var slCfg = readSheetLinkCfg_(ss);
  var feed = findSheetLinkSheet_(ss, slCfg.txTab);
  if (!feed) {
    ui.alert('Sync from SheetLink',
      'Could not find the SheetLink transactions tab.\n\n' +
      'Install the SheetLink add-on and connect your accounts so it writes a tab ' +
      'into this spreadsheet, then put its exact name on the Settings tab ' +
      '("SheetLink transactions tab"). Re-run this once the feed exists.',
      ui.ButtonSet.OK);
    return;
  }
  var values = feed.getDataRange().getValues();
  var cfg = readSettings_(ss);
  cfg.slOutPositive = slCfg.outPositive;
  var res;
  try {
    res = parseSheetLink_(values, cfg);
  } catch (err) {
    ui.alert('Sync from SheetLink',
      'Could not read "' + feed.getName() + '": ' + err.message, ui.ButtonSet.OK);
    return;
  }
  var w = writeTransactions_(ss, res.rows);
  var balMsg = syncBalances_(ss);   // feed balances are the master account list
  syncAccountsFromTx_(ss);          // add any ledger-only accounts the feed lacks
  var s = res.stats;
  ss.toast('Added ' + w.added + ' new (' + w.skipped + ' already present).',
    'SheetLink sync complete', 6);
  ui.alert('Sync from SheetLink',
    'SheetLink sync complete (tab "' + feed.getName() + '").\n' +
    'Added ' + w.added + ' new transaction(s); ' + w.skipped + ' already present.\n' +
    'Feed held ' + s.kept + ' rows (' + s.transfers + ' transfers, ' +
    s.pendingSkipped + ' pending skipped, ' + s.dupes +
    ' in-feed duplicate(s)).\n' +
    'Ledger now holds ' + w.total + ' transaction(s).\n' + balMsg + '\n\n' +
    'Check one row: if a known DEPOSIT shows as an Expense, set "SheetLink amount ' +
    'sign" to "in=positive" on the Settings tab and sync again.',
    ui.ButtonSet.OK);
}

// Pull real balances from SheetLink's accounts/balances tab into our Account Summary.
// What it does (the v2.6 fix):
//   1. Locate SheetLink's balance tab by signature (not by a name SheetLink ignores).
//   2. Trim its stale appended snapshots → keep only the latest sync.
//   3. Pick the right balance per account: credit/loan use `current_balance` signed as
//      DEBT (negative), so a card you owe $1,703 on reads -1703.33; cash accounts use the
//      AVAILABLE balance (spendable = posted − pending, what your bank app shows) when the
//      feed provides it, else current_balance.
//   4. Upsert one clean row per account (clean name, Type, Balance) into Account Summary.
// Returns a short status line for the sync summary.
function syncBalances_(ss) {
  var src = findBalancesSheet_(ss);
  if (!src) return 'Bank balances: no SheetLink balances tab found — skipped.';

  var head0 = src.getRange(1, 1, 1, Math.min(src.getLastColumn(), 40)).getValues()[0];
  var head = {};
  for (var c = 0; c < head0.length; c++) head[String(head0[c]).trim().toLowerCase()] = c;
  var nameCol = firstCol_(head, ['account_name', 'name']);
  var balCol = firstCol_(head, ['current_balance', 'balance', 'current']);
  var subCol = firstCol_(head, ['subtype', 'account_subtype', 'account_type', 'type']);
  var tsCol = firstCol_(head, ['last_synced_at', 'last_synced', 'synced_at', 'updated_at']);
  if (balCol === -1) return 'Bank balances: no current_balance column in "' + src.getName() + '".';

  var trimmed = trimBalancesSnapshot_(src, tsCol, balCol);

  var availCol = firstCol_(head, ['available_balance', 'available']);
  var vals = src.getDataRange().getValues();
  var order = [], info = {};
  for (var i = 1; i < vals.length; i++) {
    var curStr = String(vals[i][balCol]).trim();
    var availStr = availCol !== -1 ? String(vals[i][availCol]).trim() : '';
    if (curStr === '' && availStr === '') continue;            // no balance at all
    var nm = cleanAcctName_(balanceName_(vals[i], nameCol));
    if (!nm) continue;
    var sub = subCol !== -1 ? String(vals[i][subCol]).toLowerCase() : '';
    var isCredit = sub.indexOf('credit') !== -1 || sub.indexOf('loan') !== -1;
    var signed;
    if (isCredit) {
      // Credit cards: current_balance is the POSITIVE amount owed → show as debt.
      // (available_balance on a card is the spending room left, NOT what you owe.)
      signed = -Math.abs(money_(vals[i][balCol]));
    } else {
      // Cash accounts: prefer AVAILABLE balance (what your bank app shows as spendable —
      // posted minus pending) when the feed provides it; else fall back to current.
      signed = (availStr !== '') ? money_(vals[i][availCol]) : money_(vals[i][balCol]);
    }
    if (!(nm in info)) order.push(nm);
    info[nm] = { type: isCredit ? 'Credit' : 'Cash', bal: signed };  // latest wins
  }

  var acct = ss.getSheetByName(SHEETS.ACCT);
  if (!acct) return 'Bank balances: "' + SHEETS.ACCT + '" tab missing — run Rebuild first.';
  var aMax = acct.getMaxRows();
  var existing = (aMax >= 2) ? acct.getRange(2, 1, aMax - 1, 1).getValues() : [];
  var rowOf = {}, lastRow = 1;
  for (var r = 0; r < existing.length; r++) {
    var en = String(existing[r][0]).trim();
    if (en) { rowOf[en] = r + 2; lastRow = r + 2; }
  }
  var written = 0;
  for (var o = 0; o < order.length; o++) {
    var name = order[o], it = info[name];
    var row = rowOf[name];
    if (!row) { row = ++lastRow; rowOf[name] = row; acct.getRange(row, 1).setValue(name); }
    acct.getRange(row, 2).setValue(it.type);                      // B = Type (Cash / Credit)
    acct.getRange(row, 3).setValue(it.bal).setNumberFormat(CURRENCY); // C = Balance (credit negative)
    written++;
  }
  return 'Bank balances: ' + written + ' account(s) updated' +
    (trimmed ? ' (kept latest snapshot, trimmed older)' : '') + '.';
}

// ---- Write cleaned rows into the Transactions tab ----------------
// INCREMENTAL model: merge the freshly-parsed rows with whatever is already in
// the ledger, matching on the hidden Ref column so each transaction is added
// only once. Rows the importer manages all carry a Ref; the example seed rows
// (no Ref) are dropped on the first import. The merged set is re-sorted by date
// NEWEST first and the running Balance (col I) is recomputed. Returns {added,
// skipped, total}.
function writeTransactions_(ss, rows) {
  var tx = ss.getSheetByName(SHEETS.TX);
  if (!tx) throw new Error('"Clean Transactions" tab not found — run "Rebuild tracker" first.');

  // Read the whole potential data region (cols A..H). Reading cols 1-8 avoids
  // the col-I balance formulas, so getLastRow's formula-extent is irrelevant.
  var maxRows = tx.getMaxRows();
  var region = (maxRows >= 2) ? tx.getRange(2, 1, maxRows - 1, 8).getValues() : [];

  var keep = [];     // [Date, cat, desc, inc, exp, acct, type, ref]
  var seenRef = {};
  for (var i = 0; i < region.length; i++) {
    var ref = region[i][7];
    if (ref !== '' && ref !== null) {       // only import-managed rows survive
      keep.push(region[i].slice(0, 8));
      seenRef[ref] = true;
    }
  }

  // Add only transactions whose Ref isn't already present.
  var added = 0;
  for (var k = 0; k < rows.length; k++) {
    var r = rows[k];
    var rk = r[7];
    if (seenRef[rk]) continue;
    seenRef[rk] = true;
    var p = String(r[0]).split('-');
    var d = (p.length === 3) ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])) : r[0];
    keep.push([d, r[1], r[2], r[3], r[4], r[5], r[6], rk]);
    added++;
  }

  // NOTE: categorization (incl. transfer detection) runs only on a file's
  // brand-new rows, never on rows already in the ledger. Once a transaction is in
  // the sheet, your hand edits to its Category are sacred — re-importing keeps them
  // untouched. So if you label 3620's rows yourself, your labels persist across
  // every re-import.

  // Date-sort the merged ledger NEWEST first (newest at top, oldest at bottom).
  keep.sort(function (a, b) {
    var x = (a[0] instanceof Date) ? a[0].getTime() : 0;
    var y = (b[0] instanceof Date) ? b[0].getTime() : 0;
    return y - x;
  });

  // Rewrite the data region and recompute the running balance.
  tx.getRange(2, 1, maxRows - 1, 9).clearContent();
  if (keep.length) {
    tx.getRange(2, 1, keep.length, 8).setValues(keep);
    // Rows run newest-first, so the running Balance accumulates from the BOTTOM
    // (oldest) up: each row = the row below (next-older) + its own Income - Expense.
    // The last row in the set (the oldest) is the base case (prev = 0).
    var formulas = [];
    for (var f = 0; f < keep.length; f++) {
      var row = f + 2;
      var prev = (f === keep.length - 1) ? '0' : 'N(I' + (row + 1) + ')';
      formulas.push(['=IF(AND(D' + row + '="",E' + row + '=""),"",' +
        prev + '+N(D' + row + ')-N(E' + row + '))']);
    }
    tx.getRange(2, 9, keep.length, 1).setFormulas(formulas);
    tx.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy-mm-dd');
    tx.getRange(2, 4, keep.length, 2).setNumberFormat(CURRENCY);
    tx.getRange(2, 9, keep.length, 1).setNumberFormat(CURRENCY);
  }
  return { added: added, skipped: rows.length - added, total: keep.length };
}

// Append account labels seen in Transactions but not yet on the Accounts tab,
// so each new account/card gets a row where you can set its Opening Balance.
function syncAccountsFromTx_(ss) {
  var tx = ss.getSheetByName(SHEETS.TX);
  var acct = ss.getSheetByName(SHEETS.ACCT);
  if (!tx || !acct) return;

  var aMax = acct.getMaxRows();
  var aVals = (aMax >= 2) ? acct.getRange(2, 1, aMax - 1, 1).getValues() : [];
  var have = {}, lastAcct = 1;
  for (var i = 0; i < aVals.length; i++) {
    if (aVals[i][0] !== '' && aVals[i][0] !== null) { have[aVals[i][0]] = true; lastAcct = i + 2; }
  }

  var tMax = tx.getMaxRows();
  var tVals = (tMax >= 2) ? tx.getRange(2, 6, tMax - 1, 2).getValues() : [];  // F=Account, G=Type
  var add = [], seen = {};
  for (var j = 0; j < tVals.length; j++) {
    var name = cleanAcctName_(tVals[j][0]), type = tVals[j][1] || 'Cash';
    if (name === '' || have[name] || seen[name]) continue;
    seen[name] = true;
    add.push([name, type]);
  }
  if (add.length) acct.getRange(lastAcct + 1, 1, add.length, 2).setValues(add);
}

// ---- Menu handler: file-picker dialog ----------------------------
// (Non-underscore names are required for menu items and google.script.run.)
function importEverlanceCsv() {
  var html = HtmlService.createHtmlOutput(IMPORT_DIALOG_HTML_)
    .setWidth(460).setHeight(260);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import transactions from CSV');
}

// Called from the dialog with the file's text. Cleans + writes, returns a
// human-readable summary string shown back in the dialog.
function processImportedCsv(text) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var values = Utilities.parseCsv(text);
  var cfg = readSettings_(ss);
  var profile = pickProfile_(values);
  var res = profile.parse(values, cfg);
  var w = writeTransactions_(ss, res.rows);   // incremental merge
  syncAccountsFromTx_(ss);                     // surface any new accounts/cards
  var s = res.stats;
  var imbalance = round2_(s.xferIn - s.xferOut);
  ss.toast('Added ' + w.added + ' new (' + w.skipped + ' already present).',
    'Import complete', 6);
  var msg = profile.name + ' import complete.\n' +
    'Added ' + w.added + ' new transaction(s); ' + w.skipped +
    ' were already in the sheet (skipped).\n' +
    'This file held ' + s.kept + ' rows (' + s.transfers + ' transfers labelled), ' +
    s.dupes + ' in-file duplicate(s) removed.\n' +
    'Ledger now holds ' + w.total + ' transaction(s).\n';
  // Surface unreconciled internal money: when transfers in and out don't net to
  // ~0, some transfer legs are missing from the export (one-sided), so that money
  // is still sitting in income/expense and per-account balances. Make it visible.
  if (Math.abs(imbalance) >= 1) {
    msg += 'Heads-up: transfers in and out differ by $' + Math.abs(imbalance).toFixed(2) +
      ' — some internal-transfer legs appear to be missing from this export, so a ' +
      'matching amount may still be inflating an account’s balance.\n';
  }
  msg += 'Tip: set Opening Balances on the Accounts tab — without them, "Cash on ' +
    'hand" is only your net change since the first import.';
  return msg;
}

var IMPORT_DIALOG_HTML_ =
  '<!DOCTYPE html><html><head><base target="_top"><style>' +
  'body{font-family:Arial,Helvetica,sans-serif;margin:16px;font-size:13px;color:#222}' +
  'button{background:#1f3864;color:#fff;border:0;padding:8px 16px;border-radius:4px;cursor:pointer}' +
  'button:disabled{background:#9aa5b1;cursor:default}' +
  '#status{margin-top:14px;white-space:pre-wrap;line-height:1.4}' +
  '</style></head><body>' +
  '<p>Choose your CSV export (Everlance supported today). It is cleaned and ' +
  'merged into the <b>Clean Transactions</b> tab — only transactions not already ' +
  'in the sheet are added, so you can import as often as you like.</p>' +
  '<input type="file" id="file" accept=".csv,text/csv"><br><br>' +
  '<button id="btn" onclick="go()">Import</button>' +
  '<div id="status"></div>' +
  '<script>' +
  'function go(){' +
  'var f=document.getElementById("file").files[0];' +
  'var s=document.getElementById("status");' +
  'if(!f){s.textContent="Please choose a file first.";return;}' +
  'document.getElementById("btn").disabled=true;' +
  's.textContent="Reading file…";' +
  'var rd=new FileReader();' +
  'rd.onload=function(e){s.textContent="Converting…";' +
  'google.script.run' +
  '.withSuccessHandler(function(msg){s.textContent=msg;})' +
  '.withFailureHandler(function(err){s.textContent="Error: "+err.message;' +
  'document.getElementById("btn").disabled=false;})' +
  '.processImportedCsv(e.target.result);};' +
  'rd.onerror=function(){s.textContent="Could not read the file.";' +
  'document.getElementById("btn").disabled=false;};' +
  'rd.readAsText(f);}' +
  '</script></body></html>';

// Remove the auto-created "Sheet1" if it's empty and unused.
function cleanupDefaultSheet_(ss) {
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 &&
      def.getLastRow() === 0 && def.getLastColumn() === 0) {
    ss.deleteSheet(def);
  }
}

/**
 * Finance Tracker — Google Apps Script builder
 * ------------------------------------------------------------------
 * Paste this into a Google Sheet (Extensions ▸ Apps Script), then run
 * `setup()` once. It (re)builds all tabs idempotently:
 *
 *   1. Transactions      — ledger with running balance + dropdowns
 *   2. Accounts          — opening balances -> live per-account balances
 *   3. Recurring         — monthly recurring expenses + annual projection
 *   4. Goals             — savings/earnings planning (vacations, etc.)
 *   5. Dashboard         — weekly AND monthly summaries + category spend
 *   6. Categories        — config feeding dropdowns & budgets
 *   7. Settings          — your name/banks/cards, read by the CSV importer
 *
 * The CSV converter is built IN — Finance ▸ Import transactions (CSV) cleans
 * an Everlance export and merges it entirely inside the sheet (no outside
 * script). Imports are INCREMENTAL: only transactions not already present are
 * added (matched on a hidden Ref column), so you can import as often as you
 * like — daily, even.
 *
 * Re-running setup() preserves any data already typed into the tabs
 * (it only rewrites headers, formulas, formatting and validation).
 */

// ---- Config -------------------------------------------------------
var SHEETS = {
  TX: 'Transactions',
  ACCT: 'Accounts',
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
  // Col I = Balance: running cumulative net (=prev + Income - Expense), a global
  // line across all accounts; real per-account balances live on the Accounts
  // tab. Guarded so empty rows stay blank. Recomputed by the importer after each
  // load once rows are date-sorted.
  var formulas = [];
  for (var r = 2; r <= TX_LAST_ROW; r++) {
    var prev = (r === 2) ? '0' : 'I' + (r - 1);
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

// ---- Accounts (opening balances -> derived current balances) ------
// Current Balance = Opening Balance + (this account's Income) - (its Expense),
// summed over ALL transactions INCLUDING transfers — so paying a card lowers
// cash AND lowers card debt. Enter each Opening Balance yourself: what the
// account held just before the first imported transaction. Credit cards carry
// a NEGATIVE balance (debt), e.g. a card you owe $10,000 on starts at -10000.
function buildAccounts_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.ACCT);
  header_(sheet, ['Account', 'Type', 'Opening Balance', 'Current Balance']);
  sheet.getRange('D1').setNote(
    'Current Balance = Opening Balance + this account’s income − expenses.\n' +
    'A blank Opening Balance is treated as 0, so the figure then shows only the ' +
    'net change since your first import, NOT your real balance. Enter each ' +
    'account’s actual starting balance in column C to see true balances.');
  var tx = "'" + SHEETS.TX + "'";

  for (var r = 2; r <= 60; r++) {
    sheet.getRange(r, 4).setFormula(
      '=IF(A' + r + '="","",N(C' + r + ')' +
      '+SUMIF(' + tx + '!F:F,A' + r + ',' + tx + '!D:D)' +
      '-SUMIF(' + tx + '!F:F,A' + r + ',' + tx + '!E:E))'
    ).setNumberFormat(CURRENCY);
  }
  sheet.getRange('C2:D').setNumberFormat(CURRENCY);
  applyListValidation_(sheet, 'B2:B', ['Cash', 'Credit']);

  // Seed the known accounts (labels match the converter's Account column) once;
  // user fills the Opening Balance column. Re-running setup() preserves edits.
  if (sheet.getRange(2, 1).getValue() === '') {
    sheet.getRange(2, 1, 3, 2).setValues([
      ['Checking 1234', 'Cash'],
      ['Savings 5678', 'Cash'],
      ['Credit Card', 'Credit']
    ]);
  }
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 140);
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

  // --- Standing balances by account group (from the Accounts tab) ---
  var acct = "'" + SHEETS.ACCT + "'";
  var bal = function (type) {
    return '=SUMIF(' + acct + '!B2:B,"' + type + '",' + acct + '!D2:D)';
  };
  // Label is honest about what the figure means: with no Opening Balances set,
  // each account's "Current Balance" is just its net change since the first
  // import — NOT real cash — so don't call it "Cash on hand" until a starting
  // balance exists. The label flips automatically once any Opening Balance is set.
  sheet.getRange('D3').setFormula(
    '=IF(COUNT(' + acct + '!C2:C)=0,"Net change since import ⚠","Cash on hand")'
  ).setFontWeight('bold');
  sheet.getRange('D3').setNote(
    'While every Opening Balance on the Accounts tab is blank, this figure is the ' +
    'net change since your first import — NOT your real cash. Enter each account’s ' +
    'starting balance on the Accounts tab to turn this into true Cash on hand.');
  sheet.getRange('E3').setFormula(bal('Cash')).setNumberFormat(CURRENCY);
  put_(sheet, 'D4', 'Credit (debt)', true);
  sheet.getRange('E4').setFormula(bal('Credit')).setNumberFormat(CURRENCY);
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
// are NOT your name. Fill "Name tokens" yourself (kept out of code).
var SETTINGS_ROWS = [
  ['Name tokens (ALL must match)', [],
    'Distinctive parts of YOUR name — ALL must appear for a row to count as ' +
    'money moved between your own accounts (self Zelle/Cash App). Use stems: ' +
    'e.g. SMIT matches both Smith and Smithe. Blank = skip name matching.'],
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
    '(category Other) — so repayments are not mis-filed under Housing, etc.']
];

// Map each Settings row label -> the cfg field the importer uses.
var SETTINGS_KEYS = {
  'Name tokens (ALL must match)': 'nameTokens',
  'Self P2P channels': 'selfChannels',
  'Own banks': 'ownBanks',
  'Own bank rails': 'ownBankRails',
  'Own bank exclude': 'ownBankExclude',
  'Own sub-accounts': 'own360',
  'Own cards (rail-paid)': 'ownCards',
  'Card pay rails': 'cardPayRails',
  'Own card issuers (name-only)': 'ownCardIssuers',
  'Lenders (loan in / repayment out)': 'lenders'
};

function buildSettings_(ss) {
  var sheet = getOrCreate_(ss, SHEETS.SETTINGS);
  header_(sheet, ['Setting', 'Values (one per cell, add more to the right →)']);
  sheet.getRange('A1').setNote(
    'These lists let the CSV importer recognise transfers between your own ' +
    'accounts (so they move balances without distorting spend totals). ' +
    'Add a value by typing it in the next empty cell on that row.');

  // Seed once (preserve user edits on re-run).
  if (sheet.getRange(2, 1).getValue() === '') {
    for (var i = 0; i < SETTINGS_ROWS.length; i++) {
      var r = 2 + i;
      var label = SETTINGS_ROWS[i][0];
      var vals = SETTINGS_ROWS[i][1];
      var note = SETTINGS_ROWS[i][2];
      sheet.getRange(r, 1).setValue(label).setNote(note);
      if (vals.length) sheet.getRange(r, 2, 1, vals.length).setValues([vals]);
    }
  }
  sheet.setColumnWidth(1, 230);
  sheet.setFrozenColumns(1);
}

// Read the Settings tab into a cfg object. Missing/blank rows fall back
// to DEFAULT_CFG. Name tokens default to [] so your name is never in code.
function readSettings_(ss) {
  var cfg = {
    nameTokens: [],
    selfChannels: ['ZELLE', 'PERSON-TO-PERSON', 'CASH APP', 'RTP'],
    ownBanks: [],
    ownBankRails: ['RTP', 'PERSON-TO-PERSON', 'INTERNET PAYMENT', 'ACCTVERIFY', 'TRANSFER'],
    ownBankExclude: [],
    own360: [],
    ownCards: [],
    cardPayRails: ['INTERNET PAYMENT', 'E-PAYMENT', 'EPAYMENT', 'ONLINE PAYMENT', 'AUTOPAY', 'BILL PAYMENT'],
    ownCardIssuers: [],
    lenders: []
  };
  var sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) return cfg;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < data.length; i++) {
    var label = String(data[i][0]).trim();
    var key = SETTINGS_KEYS[label];
    if (!key) continue;
    var vals = [];
    for (var c = 1; c < data[i].length; c++) {
      var v = String(data[i][c]).trim();
      if (v) vals.push(v.toUpperCase());
    }
    cfg[key] = vals; // explicit (even empty) overrides the default
  }
  return cfg;
}

// ---- Format-profile engine (built to extend) ---------------------
// Add a new bank/format by pushing another {name, detect, parse} here.
var PROFILES = [{
  name: 'Everlance',
  detect: function (values) { return everlanceHeaderRow_(values) !== -1; },
  parse: function (values, cfg) { return parseEverlance_(values, cfg); }
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
  if (cfg.nameTokens.length &&
      cfg.nameTokens.every(function (tok) { return t.indexOf(tok) !== -1; }) &&
      anyIn_(t, cfg.selfChannels)) return true;
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

// ---- Internal transfer reconciliation (cross-account leg pairing) ----
// The text rules above (isTransfer_/isCardPayment_) only catch legs that name an
// account, rail or your own name. Money moved between your OWN accounts via a
// generic "DEPOSIT"/"MOBILE DEPOSIT" or a person-name P2P slips through: the
// receiving side is booked as Income and the sending side as Expense. That
// inflates whichever account the money lands in (your hub account) with phantom
// "income" it never really earned. Since every account in the export is your own,
// an Income row in one account that mirrors an Expense row in a DIFFERENT account
// (same amount, within a few days) is exactly such an internal transfer — so tag
// BOTH legs 'Transfer' and neither distorts income/expense or per-account cash.
//
// Guards against false cancels: the two legs must be on different accounts, each
// row is consumed at most once (one-to-one), and the dates must fall within
// XFER_PAIR_DAYS. Two coincidentally-equal cross-account transactions could still
// pair — rare; the import summary reports how much was paired so it stays
// auditable. rows: [date, cat, desc, inc, exp, acct, type, ref]; date is a
// 'YYYY-MM-DD' string (parse stage) or a real Date (merge stage) — both handled.
var XFER_PAIR_DAYS = 3;

function rowDateMs_(d) {
  if (d instanceof Date) return d.getTime();
  var p = String(d).split('-');
  return (p.length === 3) ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime() : 0;
}

function pairInternalTransfers_(rows) {
  var win = XFER_PAIR_DAYS * 86400000;
  // Bucket the outstanding outflow (Expense) legs by rounded amount.
  var expenses = {};   // amount -> array of row indices not yet consumed
  var i, r, amt;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (r[1] === 'Transfer' || r[4] === '' || r[4] === null) continue;
    amt = round2_(Number(r[4]));
    (expenses[amt] = expenses[amt] || []).push(i);
  }
  var paired = 0;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (r[1] === 'Transfer' || r[3] === '' || r[3] === null) continue;  // income legs only
    amt = round2_(Number(r[3]));
    var bucket = expenses[amt];
    if (!bucket) continue;
    var inMs = rowDateMs_(r[0]);
    for (var b = 0; b < bucket.length; b++) {
      var ei = bucket[b];
      if (ei < 0) continue;                       // outflow leg already consumed
      var e = rows[ei];
      if (e[5] === r[5]) continue;                // must be a DIFFERENT account
      if (Math.abs(rowDateMs_(e[0]) - inMs) > win) continue;
      r[1] = 'Transfer'; e[1] = 'Transfer';       // both legs become transfers
      bucket[b] = -1;                             // consume the outflow leg
      paired++;
      break;                                      // each inflow pairs at most once
    }
  }
  return paired;
}

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
  // Reconcile internal transfers the text rules missed (cross-account leg pairing)
  // BEFORE tallying, so phantom hub "income" is reclassified out of the totals.
  var paired = pairInternalTransfers_(out);
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  // Tally after pairing so income/expense exclude every transfer (text- or
  // pair-detected) and the transfer in/out imbalance is reported for auditing.
  var stats = { kept: out.length, transfers: 0, dupes: dupes, paired: paired,
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

// ---- Write cleaned rows into the Transactions tab ----------------
// INCREMENTAL model: merge the freshly-parsed rows with whatever is already in
// the ledger, matching on the hidden Ref column so each transaction is added
// only once. Rows the importer manages all carry a Ref; the example seed rows
// (no Ref) are dropped on the first import. The merged set is re-sorted by date
// and the running Balance (col I) is recomputed. Returns {added, skipped, total}.
function writeTransactions_(ss, rows) {
  var tx = ss.getSheetByName(SHEETS.TX);
  if (!tx) throw new Error('Transactions tab not found — run "Rebuild tracker" first.');

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

  // Reconcile internal transfers across the WHOLE merged ledger (not just this
  // file), so a transfer whose two legs arrived in separate imports — or rows
  // imported before this fix — also get paired and corrected on re-import.
  pairInternalTransfers_(keep);

  // Date-sort the merged ledger (oldest first).
  keep.sort(function (a, b) {
    var x = (a[0] instanceof Date) ? a[0].getTime() : 0;
    var y = (b[0] instanceof Date) ? b[0].getTime() : 0;
    return x - y;
  });

  // Rewrite the data region and recompute the running balance.
  tx.getRange(2, 1, maxRows - 1, 9).clearContent();
  if (keep.length) {
    tx.getRange(2, 1, keep.length, 8).setValues(keep);
    var formulas = [];
    for (var f = 0; f < keep.length; f++) {
      var row = f + 2;
      var prev = (row === 2) ? '0' : 'I' + (row - 1);
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
    var name = tVals[j][0], type = tVals[j][1] || 'Cash';
    if (name === '' || name === null || have[name] || seen[name]) continue;
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
    'This file held ' + s.kept + ' rows (' + s.transfers + ' transfers labelled, ' +
    'of which ' + s.paired + ' auto-paired across your own accounts), ' +
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
  'merged into the <b>Transactions</b> tab — only transactions not already ' +
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

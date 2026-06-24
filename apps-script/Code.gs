/**
 * Finance Tracker — Google Apps Script builder
 * ------------------------------------------------------------------
 * Paste this into a Google Sheet (Extensions ▸ Apps Script), then run
 * `setup()` once. It (re)builds all tabs idempotently:
 *
 *   1. Transactions      — ledger with running balance + dropdowns
 *   2. Dashboard         — weekly AND monthly summaries + category spend
 *   3. Recurring         — monthly recurring expenses + annual projection
 *   4. Goals             — savings/earnings planning (vacations, etc.)
 *   5. Categories        — config feeding dropdowns & budgets
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
  CATS: 'Categories'
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
                  'Account', 'Type', 'Balance']);

  // Running cumulative net (col H): =prev + Income - Expense. This is a global
  // line across all accounts; real per-account balances live on the Accounts
  // tab. Guarded so empty rows stay blank.
  var formulas = [];
  for (var r = 2; r <= TX_LAST_ROW; r++) {
    var prev = (r === 2) ? '0' : 'H' + (r - 1);
    formulas.push(['=IF(AND(D' + r + '="",E' + r + '=""),"",' +
      prev + '+N(D' + r + ')-N(E' + r + '))']);
  }
  sheet.getRange(2, 8, formulas.length, 1).setFormulas(formulas);

  // Formatting
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('D2:E').setNumberFormat(CURRENCY);
  sheet.getRange('H2:H').setNumberFormat(CURRENCY);
  sheet.setColumnWidth(3, 240);
  sheet.setColumnWidth(6, 175);

  // Category dropdown — include "Transfer" so imported transfer rows validate.
  applyCategoryValidation_(sheet, 'B2:B', cats.concat(['Transfer']));
  // Account Type dropdown (Cash / Credit).
  applyListValidation_(sheet, 'G2:G', ['Cash', 'Credit']);

  // Seed a couple of example rows when empty.
  if (sheet.getRange(2, 1).getValue() === '') {
    sheet.getRange(2, 1, 2, 7).setValues([
      [new Date(), 'Income', 'Salary', 3200, 0, 'Checking 3620', 'Cash'],
      [new Date(), 'Housing', 'Rent', 0, 1200, 'Checking 3620', 'Cash']
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
    sheet.getRange(2, 1, 8, 2).setValues([
      ['Checking 3620', 'Cash'],
      ['Checking 3639', 'Cash'],
      ['Checking 6689', 'Cash'],
      ['Savings 2991', 'Cash'],
      ['depository Account 6602', 'Cash'],
      ['depository Account 6367', 'Cash'],
      ['Robinhood Credit Card', 'Credit'],
      ['Discover it Card', 'Credit']
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
  put_(sheet, 'D3', 'Cash on hand', true);
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

// Remove the auto-created "Sheet1" if it's empty and unused.
function cleanupDefaultSheet_(ss) {
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 &&
      def.getLastRow() === 0 && def.getLastColumn() === 0) {
    ss.deleteSheet(def);
  }
}

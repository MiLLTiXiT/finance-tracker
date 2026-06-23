#!/usr/bin/env python3
"""
Convert an Everlance CSV export into the Finance Tracker's Transactions
layout: Date | Category | Description | Income | Expense.

- Splits Everlance's single signed Amount into Income / Expense.
- Drops internal account-to-account transfers (money moved between your
  own accounts), which otherwise inflate both income and expense.
- Maps Everlance's ~70 categories down to the tracker's 10.

Usage:  python3 convert_everlance.py input_everlance.csv output.csv
"""
import sys, csv, io, re

# --- Everlance category -> tracker's 10 categories ---------------------
TEN = {'Income','Housing','Groceries','Utilities','Dining','Transport',
       'Health','Entertainment','Savings','Other'}

CATEGORY_MAP = {
    # Income
    'Payroll':'Income','Revenue':'Income','Interest Earned':'Income',
    'Deposit':'Income','Check':'Income',
    # Transport
    'Gas Stations':'Transport','Gasoline':'Transport','Tolls and Fees':'Transport',
    'Car Dealers and Leasing':'Transport','Car and Truck Rentals':'Transport',
    'Car Wash and Detail':'Transport','Other Vehicle Related Expenses':'Transport',
    'Maintenance and Repair':'Transport','Shipping and Freight':'Transport',
    # Dining
    'Restaurants':'Dining','Fast Food':'Dining','Food and Beverage':'Dining',
    'Business Meals & Entertainment':'Dining',
    # Groceries
    'Supermarkets and Groceries':'Groceries','Food and Beverage Store':'Groceries',
    'Convenience Stores':'Groceries','Warehouses and Wholesale Stores':'Groceries',
    # Utilities
    'Telecommunication Services':'Utilities','Insurance':'Utilities',
    # Housing
    'Lodging':'Housing','Loans and Mortgages':'Housing','Storage':'Housing',
    'Hardware Store':'Housing',
    # Health
    'Pharmacies':'Health','Dentists':'Health','Glasses and Optometrist':'Health',
    'Personal Care':'Health','Gyms and Fitness Centers':'Health',
    # Entertainment
    'Arts and Entertainment':'Entertainment','Recreation':'Entertainment',
    'Subscription':'Entertainment','Digital Purchase':'Entertainment',
    'Computers and Electronics':'Entertainment','Tobacco':'Entertainment',
    # Savings / investments
    'Stock Brokers':'Savings',
    # Everything else -> Other (Shops, Bank Fees, ATM, Overdraft, Clothing,
    # Government, Charitable Donation, Office Supplies, etc.) handled by default.
}

# Generic bank labels: direction decides (money in = Income, out = Other).
GENERIC = {'Credit','Debit','Withdrawal','Payment','Credit Card','Banking and Finance'}

def map_category(everlance_cat, is_income):
    if everlance_cat in CATEGORY_MAP:
        return CATEGORY_MAP[everlance_cat]
    if everlance_cat in GENERIC:
        return 'Income' if is_income else 'Other'
    return 'Income' if is_income else 'Other'

# --- Transfer detection ------------------------------------------------
# Internal account transfers only (own-account shuffles). Deliberately does
# NOT match gig payouts like "AMAZON FLEX PAYOUT ... VISA MONEY TRANSFER".
MASKED_XFER = re.compile(r'(TO|FROM)\s+\*+\s*\d{3,}', re.I)
def is_transfer(text):
    t = text.upper()
    if MASKED_XFER.search(t):
        return True
    if 'ONLINE TRANSFER' in t or 'DEPOSIT TRANSFER' in t:
        return True
    return False

def money(s):
    s = s.strip().replace('$','').replace(',','')
    if s in ('','-'): return 0.0
    neg = s.startswith('-'); s = s.lstrip('-')
    try: v = float(s)
    except ValueError: v = 0.0
    return -v if neg else v

def convert(raw):
    rows = list(csv.reader(io.StringIO(raw)))
    hi = next(i for i,r in enumerate(rows)
              if r[:4]==['Amount','Date','Merchant','Category'])
    out=[['Date','Category','Description','Income','Expense']]
    stats={'kept':0,'transfers':0,'income':0.0,'expense':0.0}
    for r in rows[hi+1:]:
        if len(r)<4 or not r[1].strip():
            continue
        amt=money(r[0]); date=r[1].strip(); merch=r[2].strip()
        ecat=r[3].strip() or 'Uncategorized'
        bankdesc=r[8].strip() if len(r)>8 else ''
        if is_transfer(merch+' '+bankdesc):
            stats['transfers']+=1
            continue
        is_income = amt>0
        cat=map_category(ecat, is_income)
        inc = round(amt,2) if amt>0 else ''
        exp = round(-amt,2) if amt<0 else ''
        if inc: stats['income']+=inc
        if exp: stats['expense']+=exp
        out.append([date,cat,merch,inc,exp]); stats['kept']+=1
    out[1:]=sorted(out[1:], key=lambda x:x[0])   # oldest -> newest
    return out, stats

if __name__=='__main__':
    inp,outp=sys.argv[1],sys.argv[2]
    raw=open(inp,encoding='utf-8',errors='replace').read()
    out,st=convert(raw)
    csv.writer(open(outp,'w',newline='')).writerows(out)
    print(f"kept {st['kept']} rows, removed {st['transfers']} transfers")
    print(f"income ${st['income']:,.2f}  expense ${st['expense']:,.2f}  "
          f"net ${st['income']-st['expense']:,.2f}")

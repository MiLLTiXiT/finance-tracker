#!/usr/bin/env python3
"""
Convert an Everlance CSV export into the Finance Tracker's Transactions
layout: Date | Category | Description | Income | Expense.

- Splits Everlance's single signed Amount into Income / Expense.
- Drops internal account-to-account transfers (money moved between your
  own accounts), which otherwise inflate both income and expense. This
  includes BOTH legs of a credit-card payment: the money leaving checking
  AND the matching "payment received" entry on the card account. The real
  expenses are the individual purchases ON the card, which are kept.
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

# Merchant-keyword -> category. Many bank rows carry only a vague "Debit"/
# "Credit Card" label, so classify them by WHO was paid. The keyword is matched
# (uppercased substring) against the merchant name; first hit wins. This pulls
# clearly-identifiable spend out of the catch-all "Other" bucket — e.g. the
# GasBuddy fuel-payment app, which the bank reports only as "Debit".
MERCHANT_MAP = [
    ('GASBUDDY', 'Transport'),                                  # fuel app
    ('EZPASS', 'Transport'), ('EZ PASS', 'Transport'),
    ('E-ZPASS', 'Transport'), ('ETOLL', 'Transport'),
    ('E-TOLL', 'Transport'), ('ETOLLAVIS', 'Transport'),
    ('MARYLAND MVA', 'Transport'),
]

def map_category(everlance_cat, merch, is_income):
    m = merch.upper()
    for kw, cat in MERCHANT_MAP:
        if kw in m:
            return cat
    if everlance_cat in CATEGORY_MAP:
        return CATEGORY_MAP[everlance_cat]
    if everlance_cat in GENERIC:
        return 'Income' if is_income else 'Other'
    return 'Income' if is_income else 'Other'

# --- Transfer detection ------------------------------------------------
# Internal account transfers only (own-account shuffles). Deliberately does
# NOT match gig payouts like "AMAZON FLEX PAYOUT ... VISA MONEY TRANSFER",
# nor rideshare income (e.g. Empower ACH CREDIT), nor Zelle/Cash App
# payments to OTHER people.
MASKED_XFER = re.compile(r'(TO|FROM)\s+\*+\s*\d{3,}', re.I)

# Account holder's name tokens — ALL must be present for a self-match.
# (Catches "Jamil Aliyy", "JAMIL ABDAL ALIYY", "Jamil Wajih Abdal Aliy".)
SELF_NAME_TOKENS = ['JAMIL', 'ALIY']

# P2P channels that, combined with the holder's own name, indicate a
# self-transfer (money moved between the holder's own accounts/apps).
SELF_CHANNELS = ['ZELLE', 'PERSON-TO-PERSON', 'CASH APP', 'RTP']

# The holder's other linked banks. Movements to/from these via instant-payment
# rails are self-transfers — but exclude same-named merchants (e.g. a purchase
# at "Capital One Arena", which is a venue, not the bank).
OWN_BANKS = ['CAPITAL ONE']
OWN_BANK_RAILS = ['RTP', 'PERSON-TO-PERSON', 'INTERNET PAYMENT', 'ACCTVERIFY', 'TRANSFER']
OWN_BANK_EXCLUDE = ['ARENA']

# The holder's own Capital One 360 sub-accounts. "WITHDRAWAL TO 360 ..." is
# money shuffled from this account into the holder's own savings/checking, and
# deposits back are the reverse — both are own-account moves, not real spend.
OWN_360_ACCTS = ['360 PERFORMANCE SAVINGS', '360 CHECKING', '360 SAVINGS']

# The holder's own credit cards. Paying your own card from checking is a
# transfer to a liability account, not a fresh expense (the card's purchases,
# if tracked, are where the real spend lives). Only the *payment* rails count —
# guarded so ordinary purchases at these merchants aren't swept up.
OWN_CARDS = ['DISCOVER']
CARD_PAY_RAILS = ['INTERNET PAYMENT', 'E-PAYMENT', 'EPAYMENT',
                  'ONLINE PAYMENT', 'AUTOPAY', 'BILL PAYMENT']

def _has_self_name(t):
    return all(tok in t for tok in SELF_NAME_TOKENS)

def is_transfer(text):
    t = text.upper()
    # Internal account shuffles (masked account numbers / online transfers).
    if MASKED_XFER.search(t):
        return True
    if 'ONLINE TRANSFER' in t or 'DEPOSIT TRANSFER' in t:
        return True
    # Self P2P: holder's own name moving money via Zelle / Cash App / RTP.
    if _has_self_name(t) and any(ch in t for ch in SELF_CHANNELS):
        return True
    # Truist <-> own other bank (e.g. Capital One) instant-payment movements,
    # excluding same-named merchants/venues.
    if any(b in t for b in OWN_BANKS) and not any(x in t for x in OWN_BANK_EXCLUDE):
        if any(r in t for r in OWN_BANK_RAILS):
            return True
    # Moves to/from the holder's own Capital One 360 sub-accounts.
    if any(a in t for a in OWN_360_ACCTS):
        return True
    # Paying off the holder's own credit card (transfer to a liability) —
    # the DEPOSIT-side leg (money leaving checking).
    if any(c in t for c in OWN_CARDS) and any(r in t for r in CARD_PAY_RAILS):
        return True
    return False

# The export also includes the credit-card accounts themselves, so each card
# payment shows up a SECOND time as money arriving at the card ("payment
# received"). That leg must be dropped too, or it gets miscounted as income.
# Purchases on the card (money out) are real expenses and are kept.
CARD_ACCT_HINT = 'CARD'                       # e.g. "Discover it Card", "Robinhood Credit Card"
CARD_PAY_MARKERS = ['THANK YOU', 'INTERNET PAYMENT', 'AUTOPAY']
# Genuine rewards/refunds arriving at the card — NOT payments, keep as income.
CARD_REWARD_MARKERS = ['STATEMENT CREDIT', 'CASHBACK', 'POINTS', 'REDEMPTION', 'REWARD']

def is_card_payment(account, amount, merch, bankdesc, ecat):
    """The card-side leg of a credit-card payment (money arriving at the card)."""
    if CARD_ACCT_HINT not in (account or '').upper():
        return False
    if amount <= 0:                # negative = a purchase on the card = real expense
        return False
    t = (merch + ' ' + bankdesc).upper()
    if any(rw in t for rw in CARD_REWARD_MARKERS):
        return False               # cashback / statement credit / points = keep
    if any(m in t for m in CARD_PAY_MARKERS):
        return True
    if ecat.strip() == 'Credit Card' and merch.strip().upper() in ('PAYMENT', 'INTERNET PAYMENT'):
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
        account=r[9].strip() if len(r)>9 else ''
        if is_transfer(merch+' '+bankdesc) or \
           is_card_payment(account, amt, merch, bankdesc, ecat):
            stats['transfers']+=1
            continue
        is_income = amt>0
        cat=map_category(ecat, merch, is_income)
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

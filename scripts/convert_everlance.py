#!/usr/bin/env python3
"""
Convert an Everlance CSV export into the Finance Tracker's Transactions
layout: Date | Category | Description | Income | Expense | Account | Type.

- Splits Everlance's single signed Amount into Income / Expense.
- Tags each row with its Account (e.g. "Checking 1234", "Visa Credit Card")
  and Type (Cash or Credit) so the tracker can derive per-account balances.
- Keeps internal account-to-account transfers (money moved between your own
  accounts) but labels them with the category "Transfer". They are needed for
  balance tracking (paying a card lowers cash AND lowers card debt) but are
  excluded from spend analytics by the Dashboard. This includes BOTH legs of a
  credit-card payment and payments labelled with only the issuer name (e.g. an
  issuer-named debit on checking that pays that issuer's credit card). The
  individual purchases ON a card stay as ordinary expenses.
- Removes exact-duplicate transactions: when an account is synced twice, the
  same charge appears 2-3x with an identical bank reference. Each real
  transaction is counted once.
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
# NOT match gig payouts like "GIG PLATFORM PAYOUT ... VISA MONEY TRANSFER",
# nor rideshare/ACH income deposits, nor Zelle/Cash App
# payments to OTHER people.
MASKED_XFER = re.compile(r'(TO|FROM)\s+\*+\s*\d{3,}', re.I)

# Account holder's name tokens — ALL must be present for a self-match.
# Use distinctive stems so the match holds however the bank spells the name
# (e.g. ['SMIT'] catches both "Smith" and "Smithe"). Leave empty to skip.
SELF_NAME_TOKENS = []

# P2P channels that, combined with the holder's own name, indicate a
# self-transfer (money moved between the holder's own accounts/apps).
SELF_CHANNELS = ['ZELLE', 'PERSON-TO-PERSON', 'CASH APP', 'RTP']

# The holder's other linked banks. Movements to/from these via instant-payment
# rails are self-transfers — but exclude same-named merchants (e.g. a purchase
# at a venue that shares the bank's name). Fill in your own banks, e.g. ['CHASE'].
OWN_BANKS = []
OWN_BANK_RAILS = ['RTP', 'PERSON-TO-PERSON', 'INTERNET PAYMENT', 'ACCTVERIFY', 'TRANSFER']
OWN_BANK_EXCLUDE = []

# The holder's own savings/checking sub-accounts. "WITHDRAWAL TO <sub-account>"
# is money shuffled into the holder's own savings/checking, and deposits back
# are the reverse — both are own-account moves, not real spend. Fill in your own.
OWN_360_ACCTS = []

# The holder's own credit cards. Paying your own card from checking is a
# transfer to a liability account, not a fresh expense (the card's purchases,
# if tracked, are where the real spend lives). Only the *payment* rails count —
# guarded so ordinary purchases at these merchants aren't swept up. e.g. ['VISA'].
OWN_CARDS = []
CARD_PAY_RAILS = ['INTERNET PAYMENT', 'E-PAYMENT', 'EPAYMENT',
                  'ONLINE PAYMENT', 'AUTOPAY', 'BILL PAYMENT']

# Card issuers the holder pays straight from checking, where the bank labels the
# outflow with ONLY the issuer name (no payment rail) — e.g. an issuer-named
# debit on the checking account that is really a credit-card payment, not a
# brokerage/investment. Such a non-card-account outflow is the checking-side leg
# of a card payment, so it's dropped (the card's purchases are where the real
# spend lives). NOTE: if you later also fund a brokerage of the same name from
# checking, switch to pair-matching (only drop an outflow with a matching
# `Payment` leg on the card) instead of dropping every issuer-named outflow.
OWN_CARD_ISSUERS = []

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
    # Movements between the holder's own linked banks via instant-payment rails,
    # excluding same-named merchants/venues.
    if any(b in t for b in OWN_BANKS) and not any(x in t for x in OWN_BANK_EXCLUDE):
        if any(r in t for r in OWN_BANK_RAILS):
            return True
    # Moves to/from the holder's own savings/checking sub-accounts.
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
CARD_ACCT_HINT = 'CARD'                       # e.g. "Visa Credit Card", "Store Card"
CARD_PAY_MARKERS = ['THANK YOU', 'INTERNET PAYMENT', 'AUTOPAY']
# Genuine rewards/refunds arriving at the card — NOT payments, keep as income.
CARD_REWARD_MARKERS = ['STATEMENT CREDIT', 'CASHBACK', 'POINTS', 'REDEMPTION', 'REWARD']

def is_card_payment(account, amount, merch, bankdesc, ecat):
    """A leg of a credit-card payment — either side, so neither is counted."""
    acct = (account or '').upper()
    t = (merch + ' ' + bankdesc).upper()
    # Checking-side leg: money leaving a NON-card account to a card issuer the
    # holder pays directly, where the bank labels it with just the issuer name
    # (e.g. an issuer name debiting checking). See OWN_CARD_ISSUERS note above.
    if CARD_ACCT_HINT not in acct and amount < 0 and \
       any(iss in t for iss in OWN_CARD_ISSUERS):
        return True
    # Card-side leg: money arriving at the card account.
    if CARD_ACCT_HINT not in acct:
        return False
    if amount <= 0:                # negative = a purchase on the card = real expense
        return False
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
    out=[['Date','Category','Description','Income','Expense','Account','Type']]
    stats={'kept':0,'transfers':0,'dupes':0,'income':0.0,'expense':0.0}
    # Drop exact-duplicate transactions first. When an account is synced twice,
    # the same charge appears 2-3x with an identical bank reference; the key is
    # the transaction's financial identity + bank reference (col 8, which carries
    # the unique ACH id for bank-fed rows), ignoring the user's tag/purpose/
    # category annotation columns so re-synced copies that differ only in tags
    # still collapse. First occurrence wins.
    seen=set()
    for r in rows[hi+1:]:
        if len(r)<4 or not r[1].strip():
            continue
        amt=money(r[0]); date=r[1].strip(); merch=r[2].strip()
        bd=r[8].strip() if len(r)>8 else ''
        ac=r[9].strip() if len(r)>9 else ''
        key=(round(amt,2), date, merch.upper(), bd.upper(), ac.upper())
        if key in seen:
            stats['dupes']+=1
            continue
        seen.add(key)
        ecat=r[3].strip() or 'Uncategorized'
        bankdesc=bd; account=ac
        # Clean account label ("Checking 1234 - 1234" -> "Checking 1234") and
        # classify Cash vs Credit (a credit-card account contains "Card").
        acct = account.split(' - ')[0].strip()
        atype = 'Credit' if 'CARD' in account.upper() else 'Cash'
        if is_transfer(merch+' '+bankdesc) or \
           is_card_payment(account, amt, merch, bankdesc, ecat):
            # Kept (not dropped) so account balances move correctly, but flagged
            # so the Dashboard's income/expense/category analytics skip it.
            cat='Transfer'
            stats['transfers']+=1
        else:
            cat=map_category(ecat, merch, amt>0)
            if amt>0: stats['income']+=round(amt,2)
            else:     stats['expense']+=round(-amt,2)
        inc = round(amt,2) if amt>0 else ''
        exp = round(-amt,2) if amt<0 else ''
        out.append([date,cat,merch,inc,exp,acct,atype]); stats['kept']+=1
    out[1:]=sorted(out[1:], key=lambda x:x[0])   # oldest -> newest
    return out, stats

if __name__=='__main__':
    inp,outp=sys.argv[1],sys.argv[2]
    raw=open(inp,encoding='utf-8',errors='replace').read()
    out,st=convert(raw)
    csv.writer(open(outp,'w',newline='')).writerows(out)
    print(f"kept {st['kept']} rows ({st['transfers']} transfers), "
          f"removed {st['dupes']} duplicates")
    print(f"income ${st['income']:,.2f}  expense ${st['expense']:,.2f}  "
          f"net ${st['income']-st['expense']:,.2f}  (transfers excluded)")

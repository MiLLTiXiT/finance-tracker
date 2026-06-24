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
- Reconciles internal transfers the text rules miss: when an inflow in one of
  your accounts mirrors an outflow in another (same amount, within a few days),
  both legs are labelled "Transfer" so a move between your own accounts is not
  counted as income on the receiving side (which would inflate that account's
  balance). Reports any leftover transfer in/out imbalance — money whose other
  leg is missing from the export.
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
    'Deposit':'Income',
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

# Lenders you borrow from (fill in your own, e.g. ['ACME LOANS']). A deposit
# from one is loan Income; a payment to one is a repayment Expense ('Other') — so
# repayments aren't mis-filed (Everlance tags them 'Loans and Mortgages' = Housing).
LENDERS = []

def map_category(everlance_cat, merch, is_income):
    m = merch.upper()
    # A check/money order YOU write is an expense; a check you DEPOSIT is income.
    # Everlance tags both 'Check', so direction (not the label) decides.
    if everlance_cat == 'Check':
        return 'Income' if is_income else 'Other'
    # Lender deposits = loan income; lender payments = repayment expense.
    for kw in LENDERS:
        if kw and kw in m:
            return 'Income' if is_income else 'Other'
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

# --- Internal transfer reconciliation (cross-account leg pairing) ------
# The text rules above only catch transfer legs that name an account, rail or
# your own name. Money moved between your OWN accounts via a generic
# "DEPOSIT"/"MOBILE DEPOSIT" or a person-name P2P slips through: the receiving
# side is booked as Income and the sending side as Expense, which inflates
# whichever account the money lands in (your hub account) with phantom "income".
# Since every account in the export is your own, an Income row mirrored by an
# Expense row in a DIFFERENT account (same amount, within a few days) is exactly
# such an internal transfer — tag BOTH legs 'Transfer'. Guards: different account,
# each row consumed at most once (one-to-one), dates within XFER_PAIR_DAYS.
XFER_PAIR_DAYS = 3

def _row_date(s):
    from datetime import date
    p = str(s).split('-')
    return date(int(p[0]), int(p[1]), int(p[2])) if len(p) == 3 else None

def pair_internal_transfers(rows):
    """Pair Income/Expense legs of internal transfers across own accounts.
    Mutates `rows` ([Date,Category,Desc,Income,Expense,Account,Type]) in place;
    returns the number of pairs reconciled."""
    expenses = {}                       # amount -> list of unconsumed outflow indices
    for i, r in enumerate(rows):
        if r[1] == 'Transfer' or r[4] in ('', None):
            continue
        expenses.setdefault(round(float(r[4]), 2), []).append(i)
    paired = 0
    for r in rows:
        if r[1] == 'Transfer' or r[3] in ('', None):   # income legs only
            continue
        bucket = expenses.get(round(float(r[3]), 2))
        if not bucket:
            continue
        in_d = _row_date(r[0])
        for b, ei in enumerate(bucket):
            if ei < 0:                                 # outflow leg already consumed
                continue
            e = rows[ei]
            if e[5] == r[5]:                           # must be a DIFFERENT account
                continue
            ed = _row_date(e[0])
            if in_d is None or ed is None or abs((ed - in_d).days) > XFER_PAIR_DAYS:
                continue
            r[1] = 'Transfer'; e[1] = 'Transfer'       # both legs become transfers
            bucket[b] = -1                             # consume the outflow leg
            paired += 1
            break                                      # each inflow pairs at most once
    return paired

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
    dupes=0
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
            dupes+=1
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
        else:
            cat=map_category(ecat, merch, amt>0)
        inc = round(amt,2) if amt>0 else ''
        exp = round(-amt,2) if amt<0 else ''
        out.append([date,cat,merch,inc,exp,acct,atype])
    # Reconcile internal transfers the text rules missed (cross-account pairing)
    # BEFORE tallying, so phantom hub "income" is reclassified out of the totals.
    paired = pair_internal_transfers(out[1:])
    out[1:]=sorted(out[1:], key=lambda x:x[0])   # oldest -> newest
    # Tally after pairing so income/expense exclude every transfer and the
    # transfer in/out imbalance (unmatched one-sided legs) is reported.
    stats={'kept':len(out)-1,'transfers':0,'dupes':dupes,'paired':paired,
           'income':0.0,'expense':0.0,'xfer_in':0.0,'xfer_out':0.0}
    for row in out[1:]:
        ii=float(row[3]) if row[3] not in ('',None) else 0.0
        ee=float(row[4]) if row[4] not in ('',None) else 0.0
        if row[1]=='Transfer':
            stats['transfers']+=1
            stats['xfer_in']=round(stats['xfer_in']+ii,2)
            stats['xfer_out']=round(stats['xfer_out']+ee,2)
        else:
            stats['income']=round(stats['income']+ii,2)
            stats['expense']=round(stats['expense']+ee,2)
    return out, stats

if __name__=='__main__':
    inp,outp=sys.argv[1],sys.argv[2]
    raw=open(inp,encoding='utf-8',errors='replace').read()
    out,st=convert(raw)
    csv.writer(open(outp,'w',newline='')).writerows(out)
    print(f"kept {st['kept']} rows ({st['transfers']} transfers, "
          f"{st['paired']} auto-paired across own accounts), "
          f"removed {st['dupes']} duplicates")
    print(f"income ${st['income']:,.2f}  expense ${st['expense']:,.2f}  "
          f"net ${st['income']-st['expense']:,.2f}  (transfers excluded)")
    imbalance = round(st['xfer_in']-st['xfer_out'], 2)
    if abs(imbalance) >= 1:
        print(f"NOTE: transfers in (${st['xfer_in']:,.2f}) and out "
              f"(${st['xfer_out']:,.2f}) differ by ${imbalance:,.2f} — some "
              f"internal-transfer legs are missing from this export, so that "
              f"amount may still be inflating an account's balance.")

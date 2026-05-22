"""Load a stored OAuth pickle from growth-tactics/google_drive/, refresh the
access token, print to stdout. Default pickle is token.pickle (Drive scope);
pass --pickle gmail_token.pickle for Gmail scope etc.
"""
import argparse
import pickle
import sys
from pathlib import Path
from google.auth.transport.requests import Request

PICKLE_DIR = Path('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/growth-tactics/google_drive')

ap = argparse.ArgumentParser()
ap.add_argument('--pickle', default='token.pickle', help='filename inside growth-tactics/google_drive/')
args = ap.parse_args()
TOKEN_PATH = PICKLE_DIR / args.pickle

if not TOKEN_PATH.exists():
    print('FAIL: token.pickle not found at', TOKEN_PATH, file=sys.stderr)
    sys.exit(1)

with open(TOKEN_PATH, 'rb') as f:
    creds = pickle.load(f)

print('scopes:', getattr(creds, 'scopes', None), file=sys.stderr)
print('expired:', getattr(creds, 'expired', None), 'valid:', getattr(creds, 'valid', None), file=sys.stderr)
print('has_refresh:', bool(getattr(creds, 'refresh_token', None)), file=sys.stderr)

if not creds.valid:
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_PATH, 'wb') as f:
            pickle.dump(creds, f)
        print('refreshed', file=sys.stderr)
    else:
        print('FAIL: cannot refresh — no refresh_token', file=sys.stderr)
        sys.exit(2)

print(creds.token)

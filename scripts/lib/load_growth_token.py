"""Load the stored Drive OAuth pickle from growth-tactics/google_drive/
token.pickle and refresh the access token. Prints the access token to
stdout on success.
"""
import pickle
import sys
from pathlib import Path
from google.auth.transport.requests import Request

TOKEN_PATH = Path('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/growth-tactics/google_drive/token.pickle')

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

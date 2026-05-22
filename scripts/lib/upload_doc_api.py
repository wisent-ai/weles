"""Upload an HTML file as a Google Doc via Drive REST API multipart-with-convert.

Reads wisent.ai OAuth credentials from growth-tactics/google_drive/token.pickle
(already consented with full drive scope). Drive converts the HTML to a native
Google Doc with real headings, bold, lists, code, links — formatted server-side,
no clipboard or UI dance.

Usage: python3 upload_doc_api.py <html-file> <title>
Prints the new Doc URL on stdout.
"""
import json
import pickle
import sys
from pathlib import Path
from google.auth.transport.requests import Request, AuthorizedSession

TOKEN_PATH = Path('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/growth-tactics/google_drive/token.pickle')

if len(sys.argv) < 3:
    print('usage: upload_doc_api.py <html-file> <title>', file=sys.stderr)
    sys.exit(2)
html_path = Path(sys.argv[1])
title = sys.argv[2]

with open(TOKEN_PATH, 'rb') as f:
    creds = pickle.load(f)
if not creds.valid:
    creds.refresh(Request())
    with open(TOKEN_PATH, 'wb') as f:
        pickle.dump(creds, f)

with open(html_path, 'rb') as f:
    html_bytes = f.read()

boundary = 'paste_doc_boundary'
metadata = {'name': title, 'mimeType': 'application/vnd.google-apps.document'}
body = (
    f'--{boundary}\r\n'
    f'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    f'{json.dumps(metadata)}\r\n'
    f'--{boundary}\r\n'
    f'Content-Type: text/html\r\n\r\n'
).encode() + html_bytes + f'\r\n--{boundary}--\r\n'.encode()

session = AuthorizedSession(creds)
resp = session.post(
    'https://www.googleapis.com/upload/drive/v3/files',
    params={'uploadType': 'multipart', 'supportsAllDrives': 'true'},
    data=body,
    headers={'Content-Type': f'multipart/related; boundary={boundary}'},
)
if resp.status_code >= 400:
    print(f'FAIL: HTTP {resp.status_code} {resp.text[:500]}', file=sys.stderr)
    sys.exit(1)
data = resp.json()
file_id = data['id']
print(f'https://docs.google.com/document/d/{file_id}/edit')

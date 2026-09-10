// The one-time code that answers Google's 2FA prompt, and the switch to the
// method that asks for it.
//
// Google defaults this fleet's accounts to a push or an SMS, which nobody is
// there to approve, so the challenge is moved to the authenticator app and
// answered from the account's own stored secret.
import crypto from 'node:crypto';

// RFC 6238 TOTP (SHA1, 6-digit, 30s) from a base32 secret; verified vs RFC vectors.
function b32decode(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';const clean=String(s).replace(/=+$/,'').toUpperCase().replace(/\s/g,'');let bits='';const out=[];for(const c of clean){const v=A.indexOf(c);if(v<0)continue;bits+=v.toString(2).padStart(5,'0');}for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out);}
function totp(secretB32,forTime=Date.now(),digits=6,step=30){const key=b32decode(secretB32);let tt=Math.floor((forTime/1000)/step);const buf=Buffer.alloc(8);for(let i=7;i>=0;i-=1){buf[i]=tt&0xff;tt=Math.floor(tt/256);}const h=crypto.createHmac('sha1',key).update(buf).digest();const o=h[h.length-1]&0xf;const n=((h[o]&0x7f)<<24)|((h[o+1]&0xff)<<16)|((h[o+2]&0xff)<<8)|(h[o+3]&0xff);return String(n%(10**digits)).padStart(digits,'0');}
// A live TOTP from login.totpSecret when the account carries one; otherwise the
// code the operator supplied in CLAUDE_2FA_CODE. A stored secret that cannot be
// turned into a code is a broken credential and says so rather than quietly
// handing the prompt to the operator's env. Returns null when the account has no
// secret and no code was supplied.
export function resolveOtp(login) {
  if (login && login.totpSecret) return totp(login.totpSecret);
  return process.env.CLAUDE_2FA_CODE || null;
}


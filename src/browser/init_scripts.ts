// Inline addInitScript bodies extracted from async_api.ts to keep that file
// under the 300-line cap. Behavior preserved 1:1 — just relocated, with all
// short-circuit defaulting rewritten as explicit if-checks.

// WebAuthn passkey stub — reject publicKey with NotAllowedError (like a real
// browser without authenticator). Returning a hanging Promise gets detected
// (Reddit's anti-bot loops 39x vs 4x on human).
export const WEBAUTHN_REJECT_SCRIPT = `try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){if(o&&o.publicKey){var exc=new DOMException('The operation is not supported.','NotAllowedError');return Promise.reject(exc)}return _og(o)}}catch(e){}`;

// Arkose iframe-data observer for custom-Chromium path. Do NOT pre-create
// window.__arkoseData — that shows up as an extra own-window property on
// every page (about:blank, TikTok) and fingerprint diffs flag it. Only
// materialize when an Arkose iframe appears.
export const ARKOSE_OBSERVER_SCRIPT = `try{new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.id==='arkoseFrame'){var s=n.getAttribute('src');if(s===null)s='';var pkm=s.match(/\\/([A-F0-9-]{36})\\//);var pk=pkm?pkm[1]:'';var blm=s.match(/[?&]data=([^&]+)/);var bl=blm?blm[1]:'';window.__arkoseData={publicKey:pk,blob:decodeURIComponent(bl),subdomain:(new URL(s)).origin,ts:Date.now()};console.log('[arkose] captured pkey='+pk.slice(0,12))}})})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}`;

// Stock-Chromium variant: pre-creates window.__arkoseData=null on load.
// Acceptable on the stock branch — diff sensitivity is lower since the whole
// stock-Playwright path is non-default.
export const ARKOSE_OBSERVER_SCRIPT_STOCK = `try{window.__arkoseData=null;new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.id==='arkoseFrame'){var s=n.getAttribute('src');if(s===null)s='';var pkm=s.match(/\\/([A-F0-9-]{36})\\//);var pk=pkm?pkm[1]:'';var blm=s.match(/[?&]data=([^&]+)/);var bl=blm?blm[1]:'';window.__arkoseData={publicKey:pk,blob:decodeURIComponent(bl),subdomain:(new URL(s)).origin,ts:Date.now()};console.log('[arkose] captured pkey='+pk.slice(0,12))}})})}).observe(document.documentElement,{childList:true,subtree:true})}catch(e){}`;

// fetch intercept for /auth/register POST: capture form_data + x-* headers
// pre-request and captcha_response on 4xx (Discord / hCaptcha Enterprise pattern).
export const FETCH_REGISTER_INTERCEPT_SCRIPT = `try{var _of=window.fetch;window.fetch=function(){var u=arguments[0],o=arguments[1];if(!o)o={};if(typeof u==='string'&&u.includes('/auth/register')&&o.method==='POST'){try{window.__weles_form_data=JSON.parse(o.body)}catch(e){}try{var h=o.headers;if(!h)h={};window.__weles_extra_headers={};for(var k in h){if(k.startsWith('x-'))window.__weles_extra_headers[k]=h[k]}}catch(e){}}return _of.apply(this,arguments).then(function(r){if(typeof u==='string'&&u.includes('/auth/register')&&r.status>=400){r.clone().json().then(function(d){if(d.captcha_key!==undefined)window.__weles_captcha_response=d}).catch(function(){})}return r})}}catch(e){}`;

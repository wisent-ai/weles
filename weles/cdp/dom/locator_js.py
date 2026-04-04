"""JavaScript snippets evaluated by CDPLocator for DOM interaction.

Each snippet is a JS arrow function accepting a single argument (array).
The locator passes [selector, index] or [selector, index, extra] via
frame.evaluate(snippet, [selector, index]). index=-1 means first match.
"""

bbox = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}"""

visibility = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    if (!el) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}"""

focus_el = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    if (el) el.focus();
}"""

clear_input = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    if (!el) return;
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', {bubbles: true}));
}"""

count_els = "(a) => document.querySelectorAll(a[0]).length"

text_content = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? el.textContent : null;
}"""

inner_text = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? el.innerText : null;
}"""

inner_html = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? el.innerHTML : null;
}"""

get_attr = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? el.getAttribute(a[2]) : null;
}"""

is_checked = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? !!el.checked : false;
}"""

is_enabled = """(a) => {
    var els = document.querySelectorAll(a[0]);
    var el = a[1] === -1 ? els[0] : els[a[1]];
    return el ? !el.disabled : false;
}"""

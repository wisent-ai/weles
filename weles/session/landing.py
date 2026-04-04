"""Wisent-branded landing page builder for human interaction flows."""

_WISENT_LOGO_SVG = (
    '<svg width="48" height="46" viewBox="0 0 48 46" fill="none" '
    'xmlns="http://www.w3.org/2000/svg"><path d="M48 20.4982V25.3404C47.85 '
    '26.1006 47.73 26.8672 47.5466 27.6194C45.4884 36.1204 40.2216 41.8906 '
    '31.7384 44.8282C30.0616 45.4092 28.25 45.619 26.5 46H21.8334C21.62 '
    '45.9516 21.4084 45.8886 21.1916 45.858C11.4183 44.4958 4.79 39.3098 '
    '1.355 30.3794C0.66 28.5716 0.44 26.5944 0 24.6948V21.1438C0.155 '
    '20.2512 0.266666 19.3474 0.473334 18.4662C2.60834 9.32106 8.40166 '
    '3.47824 17.6167 0.77635C18.8767 0.406736 20.2034 0.253404 21.5 '
    '0H26.5C26.6866 0.046808 26.87 0.112982 27.06 0.135578C37.1234 '
    '1.34772 45.38 8.63508 47.54 18.2208C47.71 18.9762 47.8484 19.738 '
    '48 20.4982ZM5.56 12.8074C5.44666 12.9429 5.36334 13.0188 5.31 '
    '13.1092C4.045 15.2881 3.26166 17.6253 2.92166 20.0964C2.89166 '
    '20.3158 3.14666 20.679 3.37166 20.8098C4.82 21.6522 6.27 22.4996 '
    '7.77666 23.2404C8.47666 23.5842 8.665 23.9846 8.67 24.7142C8.72334 '
    '32.221 12.0817 38.009 18.4517 42.2216C19.01 42.5912 19.505 42.6558 '
    '20.145 42.4282C24.785 40.7722 28.4034 37.9088 31.1166 33.9174C32.0684 '
    '32.518 31.8916 32.7568 33.3784 33.0828C35.8384 33.6236 38.2966 '
    '34.1676 40.7466 34.7404C41.2316 34.8534 41.5366 34.7776 41.7566 '
    '34.337C42.635 32.5792 43.5366 30.833 44.3966 29.0688C44.5766 '
    '28.6992 44.6234 28.2666 44.745 27.8162C30.89 24.6222 17.8117 '
    '19.7962 5.56 12.8074ZM45.1784 25.1968C46.3634 16.1565 40.6534 '
    '6.59978 30.39 3.48792C21.33 0.740842 11.825 4.1513 7.10166 '
    '10.6107C18.9933 17.3896 31.7134 22.1058 45.1784 25.1968ZM24.7816 '
    '43.3466C29.1866 43.7306 37.6166 40.1008 39.23 37.2002C37.405 '
    '36.7678 35.5716 36.3448 33.7466 35.8896C33.3066 35.78 33.0616 '
    '35.8526 32.7884 36.235C31.3216 38.2816 29.565 40.07 27.495 '
    '41.5534C26.65 42.1586 25.7584 42.7042 24.7816 43.3466ZM10.44 '
    '38.6464C7.60834 34.7228 6.085 30.3938 5.87834 25.6276C5.87166 '
    '25.4678 5.76666 25.2418 5.63334 25.166C4.71166 24.6414 3.77166 '
    '24.1476 2.68834 23.565C3.09834 29.7724 5.64166 34.755 10.44 '
    '38.6464Z" fill="#444444"/></svg>'
)


def build_landing_html(domain, url, task, purpose="login"):
    """Build a Wisent-branded landing page.

    Args:
        domain: Display domain (e.g. "dashboard.oxylabs.io")
        url: Full URL to link to
        task: Description of what the human needs to do
        purpose: "login" or "comparison" — adjusts messaging
    """
    if purpose == "login":
        title = f"Sign in to {domain}"
        subtitle = (f"Wisent needs access to your {domain} account. "
                    f"Please sign in once — your session will be "
                    "remembered for future runs.")
        step2 = f"Sign in to your {domain} account"
        footer = "Your session is stored on this device only."
        btn_text = f"Go to {domain}"
    else:
        title = f"Help Wisent learn from {domain}"
        subtitle = (f"Wisent tried to automate {domain} but was blocked. "
                    "Please do the same task manually so Wisent can "
                    "learn what a real browser does differently.")
        step2 = task if task else f"Use {domain} as you normally would"
        footer = "All data stays on this device."
        btn_text = f"Go to {domain}"

    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Wisent</title>"
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/'
        '@github/hubot-sans@1.0.0/HubotSans.min.css">'
        "<style>"
        "*{margin:0;padding:0;box-sizing:border-box}"
        "body{font-family:'Hubot Sans',-apple-system,system-ui,sans-serif;"
        "background:#fafaf9;color:#111;height:100vh;"
        "display:flex;align-items:center;justify-content:center}"
        ".wrap{max-width:360px;width:100%;padding:0 32px}"
        ".logo-wrap{display:flex;justify-content:center;margin-bottom:24px}"
        ".logo{width:48px;height:48px;border:1px solid #e5e5e5;"
        "border-radius:50%;padding:8px;background:#fff;"
        "display:flex;align-items:center;justify-content:center}"
        ".logo svg{width:100%;height:100%}"
        "h1{font-size:18px;font-weight:600;text-align:center;margin-bottom:8px}"
        ".desc{font-size:14px;color:#666;text-align:center;"
        "line-height:1.5;margin-bottom:24px}"
        ".steps{list-style:none;margin-bottom:24px}"
        ".steps li{display:flex;align-items:center;padding:12px 0;"
        "border-bottom:1px solid #eee;font-size:14px;color:#111}"
        ".steps li:last-child{border:none}"
        ".num{flex-shrink:0;width:22px;height:22px;background:#f5f5f5;"
        "border-radius:50%;text-align:center;line-height:22px;"
        "font-size:11px;color:#666;margin-right:12px}"
        ".btn{display:block;width:100%;padding:12px;background:#111;"
        "color:#fff;border:none;border-radius:8px;font-size:14px;"
        "font-weight:500;cursor:pointer;text-align:center;"
        "text-decoration:none;font-family:inherit;transition:background .15s}"
        ".btn:hover{background:#333}"
        ".footer{margin-top:16px;font-size:12px;color:#aaa;text-align:center;"
        "line-height:1.4}"
        "</style></head><body>"
        '<div class="wrap">'
        f'<div class="logo-wrap"><div class="logo">{_WISENT_LOGO_SVG}</div></div>'
        f"<h1>{title}</h1>"
        f'<p class="desc">{subtitle}</p>'
        '<ol class="steps">'
        f'<li><span class="num">1</span>{btn_text}</li>'
        f'<li><span class="num">2</span>{step2}</li>'
        '<li><span class="num">3</span>Close this window when you&#39;re done</li>'
        "</ol>"
        f'<a class="btn" href="{url}">{btn_text}</a>'
        f'<p class="footer">{footer}</p>'
        "</div></body></html>"
    )

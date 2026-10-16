import re, time
from playwright.sync_api import sync_playwright
def connect():
    pw = sync_playwright().start()
    ws = re.search(r'ws://\S+', open('/tmp/electron.log').read()).group(0)
    b = pw.chromium.connect_over_cdp(ws)
    return pw, b
def pages(b): return [p for c in b.contexts for p in c.pages]
def page(b, web=False): return [p for p in pages(b) if ('web=' in p.url) == web][0]

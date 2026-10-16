"""Phone app end to end against a real VPS running `rcc serve` (with the mock claude), through an SSH tunnel.
usage: python3 e2e.py BASE_URL PAIR_CODE OUTDIR
"""
import sys, time, json
from playwright.sync_api import sync_playwright

base, code, out = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
ok = []
def check(name, cond):
    ok.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--no-proxy-server'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
                        locale='zh-CN', color_scheme='light')
    pg = ctx.new_page()
    cdp = ctx.new_cdp_session(pg); cdp.send('Network.enable'); cdpev = {}
    cdp.on('Network.requestWillBeSent', lambda e: cdpev.__setitem__(e['requestId'], e['request']['url'][22:70]) if '/api/' in e['request']['url'] else None)
    cdp.on('Network.responseReceived', lambda e: cdpev.pop(e['requestId'], None))
    cdp.on('Network.loadingFailed', lambda e: cdpev.pop(e['requestId'], None))
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    netlog = []
    inflight = {}
    pg.on('request', lambda r: inflight.__setitem__(id(r), r.url[:80]) if '/api/' in r.url else None)
    pg.on('requestfinished', lambda r: inflight.pop(id(r), None))
    pg.on('requestfailed', lambda r: inflight.pop(id(r), None))
    pg.on('request', lambda r: netlog.append('REQ '+r.url[:70]) if ('desk' in r.url or '/vnc' in r.url) else None)
    pg.on('response', lambda r: netlog.append('RES %s %s' % (r.status, r.url[:60])) if 'desk' in r.url else None)
    pg.on('websocket', lambda w: (netlog.append('WS '+w.url[:50]), w.on('close', lambda *_: netlog.append('WS closed'))))
    pg.on('console', lambda m: netlog.append('CON '+m.text[:120]))
    try:
        # 1. wrong code, then pairing through the QR link
        pg.goto(base + '/')
        pg.fill('.codebox input', 'AAAA2222'); pg.click('button.btn.pri'); pg.wait_for_selector('.err')
        check('wrong code rejected', '不对' in pg.inner_text('.err'))
        pg.screenshot(path=f'{out}/m0-pair.png')
        pg.goto(base + f'/#pair={code}'); pg.wait_for_selector('text=会话', timeout=15000)
        check('paired via link', pg.evaluate("!!localStorage.getItem('rcc.token')"))
        tok = pg.evaluate("localStorage.getItem('rcc.token')")
        # 2. new task
        pg.click('.fab'); pg.wait_for_selector('text=项目目录')
        pg.fill('input.field', '~/code/demo')
        pg.fill('textarea.field', '帮我改一下 session 字段')
        pg.click('text=开始'); pg.wait_for_selector('.ch', timeout=20000)
        pg.wait_for_selector('.sheet >> text=Claude 想修改文件', timeout=20000)
        check('permission sheet pops', True)
        pg.screenshot(path=f'{out}/m2-perm.png')
        pg.click('text=允许一次')
        pg.wait_for_selector('.permcard >> text=已允许', timeout=15000)
        pg.wait_for_selector('.think', state='detached', timeout=15000)
        check('allowed and finished', 'lastSeenAt' in pg.inner_text('.msgs'))
        # 3. second message with a photo (EXIF must be gone on the VPS side)
        pg.set_input_files('input[type=file]', files=[{'name': 'gps.jpg', 'mimeType': 'image/jpeg', 'buffer': open('/tmp/exif.jpg', 'rb').read()}])
        pg.wait_for_selector('.att img')
        pg.fill('.box textarea', '看看这张图')
        pg.click('.send'); pg.wait_for_selector('text=附带 1 张图片', timeout=20000)
        check('image sent', True)
        pg.screenshot(path=f'{out}/m1-chat.png')
        # 4. options sheet
        pg.click('.box .chip >> nth=0'); pg.wait_for_selector('text=思考强度')
        pg.screenshot(path=f'{out}/m3-options.png')
        pg.click('.dim', position={'x': 20, 'y': 20})
        # 5. back to list
        pg.click('.ch .ib >> nth=0'); pg.wait_for_selector('.row')
        time.sleep(1.5)
        pg.screenshot(path=f'{out}/m4-list.png')
        check('session in list', pg.locator('.row').count() >= 1)
        # 6. projects
        pg.click('.tabbar >> text=项目'); pg.wait_for_selector('.row', timeout=60000)
        pg.screenshot(path=f'{out}/m5-projects.png')
        # 7. settings
        pg.click('.tabbar >> text=设置'); pg.wait_for_selector('text=已配对的设备')
        time.sleep(1)
        pg.screenshot(path=f'{out}/m6-settings.png', full_page=True)
        check('device listed', 'iPhone' in pg.inner_text('.scroll'))
        # 8. web view (opens the account's VPS browser)
        pg.click('.tabbar >> text=网页版')
        try:
            pg.wait_for_selector('.web .ov', state='detached', timeout=120000)
            time.sleep(4)
            check('web screen connected', True)
        except Exception as e:
            check('web screen connected', False); print('EXC', repr(e)[:300]); print(pg.inner_text('.web')); print('\n'.join(netlog[-25:])); print('INFLIGHT', list(inflight.values())); print('CDP PENDING', list(cdpev.values()))
        pg.screenshot(path=f'{out}/m7-web.png')
        with pg.expect_response(lambda r: '/api/desk/cmd' in r.url and r.request.method == 'POST' and 'tabs' in (r.request.post_data or '')) as resp:
            pg.click('[aria-label=标签页]')
        check('browser tabs via CDP', resp.value.status == 200)
        pg.click('.dim', position={'x': 20, 'y': 20})
        pg.click('[aria-label=键盘]'); pg.fill('.kbbar input', '你好 👋 中文输入')
        with pg.expect_response(lambda r: '/api/desk/cmd' in r.url and 'insert' in (r.request.post_data or '')) as resp:
            pg.click('.kbbar >> text=发送')
        check('typed Chinese into VPS page', resp.value.status == 200)
        # 9. dark mode
        pg.click('.tabbar >> text=设置'); pg.click('text=深色'); pg.click('.tabbar >> text=会话'); time.sleep(0.5)
        pg.screenshot(path=f'{out}/m8-dark.png')
        check('no page errors', not errors)
        if errors: print(errors)
        json.dump({'token': tok}, open(f'{out}/token.json', 'w'))
    except Exception as e:
        import traceback; traceback.print_exc(limit=1)
        pg.screenshot(path=f'{out}/fail.png'); print('FAILED AT', e.__class__.__name__)
    b.close()
print('RESULT', sum(1 for _, c in ok if c), '/', len(ok))

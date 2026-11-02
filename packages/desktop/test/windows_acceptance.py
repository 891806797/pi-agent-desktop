"""Windows native WebView2 acceptance. Args: native-exe web-exe bun-exe.

Uses the real Tauri IPC, compiled sidecar and a localhost fixture provider.
Refuses pre-existing user data. No real model credentials are used.
"""
import base64
import ctypes
from contextlib import closing
import json
import os
import pathlib
import socket
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

repo = pathlib.Path(__file__).resolve().parents[3]
artifacts = pathlib.Path(os.environ.get('TEMP', '.')) / 'desktop'
artifacts.mkdir(exist_ok=True)
appdata = pathlib.Path(os.environ['LOCALAPPDATA']) / 'com.pi-agent.desktop'
marker = appdata / '.acceptance-owned'
if appdata.exists() and not marker.exists():
    database = appdata / 'runtime.sqlite'
    if database.exists():
        with closing(sqlite3.connect(database)) as connection:
            assert connection.execute('select count(*) from users').fetchone()[0] == 0, 'Refusing existing desktop user data'
    else:
        raise RuntimeError('Refusing unknown desktop application data')
if marker.exists():
    assert marker.read_text(encoding='utf-8') == 'pi-agent-native-acceptance'
    database = appdata / 'runtime.sqlite'
    if database.exists():
        with closing(sqlite3.connect(database)) as connection:
            assert all(row[0] == 'desktop-acceptance' for row in connection.execute('select username from users')), 'Refusing non-test users'
    expected = pathlib.Path(os.environ['LOCALAPPDATA']) / 'com.pi-agent.desktop'
    assert appdata.resolve() == expected.resolve() and appdata.name == 'com.pi-agent.desktop'
    for item in appdata.iterdir():
        if item == marker: continue
        if item.is_dir() and not item.is_symlink(): shutil.rmtree(item)
        else: item.unlink()
    marker.unlink()
    appdata.rmdir()
appdata.mkdir(exist_ok=True)
marker.write_text('pi-agent-native-acceptance', encoding='utf-8')
fixture = subprocess.Popen([sys.argv[3], '--no-env-file', 'run', str(repo / 'packages/backend/test/probes/browser-fixture.ts'), sys.argv[2]], cwd=repo, stdout=subprocess.PIPE, stderr=(artifacts / 'native-fixture.log').open('w', encoding='utf-8'), text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
info = None
child = None
user32 = ctypes.windll.user32
user32.GetMenu.restype = ctypes.c_void_p
user32.GetMenu.argtypes = [ctypes.c_void_p]
user32.GetSubMenu.restype = ctypes.c_void_p
user32.GetSubMenu.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetMenuItemCount.argtypes = [ctypes.c_void_p]
user32.GetMenuItemID.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetMenuStringW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_int, ctypes.c_uint]
kernel32 = ctypes.windll.kernel32
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

def gone(pid):
    handle = kernel32.OpenProcess(0x100000, False, int(pid))
    if not handle: return True
    try: return kernel32.WaitForSingleObject(handle, 0) == 0
    finally: kernel32.CloseHandle(handle)

def window_for(pid):
    found = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_ssize_t)
    def check(hwnd, unused):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, 256)
        if owner.value == pid and title.value == 'Pi Agent' and user32.IsWindowVisible(hwnd): found.append(hwnd)
        return True
    callback = callback_type(check)
    user32.EnumWindows(callback, 0)
    assert found, 'Visible native window missing'
    return found[0]

def quit_native():
    hwnd = window_for(child.pid)
    menu = user32.GetMenu(ctypes.c_void_p(hwnd))
    for top in range(user32.GetMenuItemCount(menu)):
        submenu = user32.GetSubMenu(menu, top)
        for item in range(user32.GetMenuItemCount(submenu)):
            text = ctypes.create_unicode_buffer(256)
            user32.GetMenuStringW(submenu, item, text, 256, 0x400)
            if '退出应用' in text.value:
                command = user32.GetMenuItemID(submenu, item)
                assert user32.PostMessageW(ctypes.c_void_p(hwnd), 0x111, command, 0)
                return
    raise RuntimeError('Native quit menu item missing')

def launch(playwright):
    global child
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = {**os.environ, 'PI_OFFLINE': '1', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': f'--remote-debugging-port={port}'}
    child = subprocess.Popen([sys.argv[1]], cwd=repo, env=env, stdout=(artifacts / 'native-host.log').open('a', encoding='utf-8'), stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(120):
        assert child.poll() is None, 'Native host exited during startup'
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=.4): pass
            break
        except OSError: time.sleep(.2)
    else: raise RuntimeError('WebView2 CDP startup timed out')
    browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
    return browser.contexts[0].pages[0]

def api(page, path, body=None, method=None, headers=None):
    result = page.evaluate('''async ({path, body, method, headers}) => {
      const reply = await window.__TAURI_INTERNALS__.invoke('backend_request', {request: {
        path: '/api/' + path, method: method || (body == null ? 'GET' : 'POST'), headers: headers || {},
        ...(body == null ? {} : {body: JSON.stringify(body)})
      }});
      return {status: reply.status, ...JSON.parse(reply.body)};
    }''', {'path': path, 'body': body, 'method': method, 'headers': headers})
    assert result['ok'], f"API failed {path}: {result}"
    return result['data']

try:
    info = json.loads(fixture.stdout.readline())
    models = json.load(urllib.request.urlopen(info['control'] + '/prepare'))['models']
    encoded = info['workspaces'][0]
    workspace = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode()
    with sync_playwright() as pw:
        page = launch(pw)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.wait_for_url('**/login')
        page.get_by_label('用户名', exact=True).fill('desktop-acceptance')
        page.get_by_label('密码', exact=True).fill('native-isolated-password')
        page.get_by_role('button', name='登录', exact=True).click()
        page.wait_for_url('**/chat**')
        api(page, 'settings/models', models, 'PUT')
        api(page, 'workspaces', {'path': workspace})
        sid = api(page, 'sessions', {'workspace': encoded})['sessionId']
        headers = {'x-session-id': sid, 'x-workspace-dir': encoded}
        api(page, 'session/run-mode', {'mode': 'safe'}, 'PUT', headers)
        url = 'http://tauri.localhost/chat?' + urllib.parse.urlencode({'workspace': encoded, 'sessionId': sid})
        page.goto(url)
        editor = page.locator('[contenteditable="true"]')
        expect(editor).to_be_visible()
        editor.fill('browser-permission'); editor.press('Enter')
        expect(page.get_by_text('浏览器验收等待中', exact=True)).to_be_visible(timeout=15000)
        urllib.request.urlopen(info['control'] + '/release').close()
        expect(page.get_by_role('button', name='允许', exact=True)).to_be_visible(timeout=15000)
        page.screenshot(path=str(artifacts / 'native-permission.png'))
        page.get_by_role('button', name='允许', exact=True).click()
        expect(page.get_by_text('浏览器验收已完成', exact=True)).to_be_visible()
        print('NATIVE_PASS actual IPC login + model config + SDK permission + SSE + answer', flush=True)
        editor.fill('browser-question'); editor.press('Enter')
        page.get_by_text('继续验收', exact=True).click(timeout=15000)
        page.get_by_role('button', name='完成', exact=True).click()
        page.get_by_role('button', name='提交', exact=True).click()
        expect(page.get_by_text('浏览器验收选择', exact=True)).to_have_count(0)
        print('NATIVE_PASS AskUserQuestion answer roundtrip', flush=True)
        editor.fill('browser-thinking'); editor.press('Enter')
        expect(page.get_by_text('浏览器验收等待中', exact=True)).to_be_visible()
        hwnd = window_for(child.pid)
        user32.PostMessageW(ctypes.c_void_p(hwnd), 0x0010, 0, 0)
        page.wait_for_timeout(500)
        assert child.poll() is None, 'Closing window killed background agent'
        assert not user32.IsWindowVisible(ctypes.c_void_p(hwnd)), 'Window did not hide to tray'
        print('NATIVE_VISIBILITY', page.evaluate('({visibility:document.visibilityState,focus:document.hasFocus()})'), flush=True)
        urllib.request.urlopen(info['control'] + '/release').close()
        for _ in range(60):
            state = api(page, 'session/messages', headers=headers)
            if state['status'] == 'idle': break
            time.sleep(.2)
        else: raise RuntimeError('Hidden agent did not complete')
        row = next(item for item in api(page, 'sessions')['sessions'] if item['sessionId'] == sid)
        assert row['noticeKind'] == 'completed' and row['noticeVersion'] > row['readVersion'], 'Background completion was incorrectly marked read: '+str(row)
        second = subprocess.Popen([sys.argv[1]], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        assert second.wait(timeout=15) == 0
        expect(editor).to_be_visible()
        page.wait_for_timeout(800)
        assert child.poll() is None
        print('NATIVE_PASS close-to-tray + hidden completion unread + single instance restore', flush=True)
        api(page, 'session/run-mode', {'mode': 'auto'}, 'PUT', headers)
        editor.fill('browser-native-long-tool'); editor.press('Enter')
        pidfile = pathlib.Path(workspace) / 'native-tool-pids.json'
        for _ in range(100):
            try:
                pids = json.loads(pidfile.read_text())
                if len(pids) == 2: break
            except (OSError, ValueError): pass
            time.sleep(.2)
        else: raise RuntimeError('Actual SDK nested tool did not start: ' + page.locator('body').inner_text()[-1000:])
        assert all(not gone(pid) for pid in pids)
        quit_native()
        assert child.wait(timeout=20) == 0, 'Explicit quit failed'
        for _ in range(50):
            if all(gone(pid) for pid in pids): break
            time.sleep(.1)
        assert all(gone(pid) for pid in pids), 'SDK tool descendants survived explicit quit'
        print('NATIVE_PASS explicit native menu quit during real SDK nested tool: both descendants exited', flush=True)
        page = launch(pw)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.wait_for_url('**/chat**')
        api(page, 'sessions', {'workspace': encoded, 'resumeSessionId': sid})
        restored = api(page, 'session/messages', headers=headers)
        assert restored['messages'], 'History lost after restart'
        assert json.loads(pidfile.read_text()) == pids and all(gone(pid) for pid in pids), 'Old tool replayed after restart'
        api(page, 'auth/logout', {})
        quit_native()
        assert child.wait(timeout=20) == 0
        assert not errors, errors
        print('NATIVE_ACCEPTANCE_PASS: restart history + cookie restore + no old tool replay + no pageerror', flush=True)
except BaseException:
    try:
        print('NATIVE_DIAGNOSTIC', page.locator('body').inner_text()[-4000:], flush=True)
    except Exception: pass
    raise
finally:
    if child and child.poll() is None:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
    if info:
        try:
            urllib.request.urlopen(info['control'] + '/release', timeout=3).close()
            urllib.request.urlopen(info['control'] + '/stop', timeout=3).close()
        except OSError: pass
    try: fixture.wait(timeout=8)
    except subprocess.TimeoutExpired: fixture.kill(); fixture.wait()

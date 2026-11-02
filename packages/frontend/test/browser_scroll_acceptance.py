"""编译版真实浏览器滚动回归；参数同 browser_acceptance.py，隔离临时数据。"""
import json
import pathlib
import subprocess
import sys
import urllib.request
from playwright.sync_api import sync_playwright, expect

repo = pathlib.Path(__file__).resolve().parents[3]
fixture = subprocess.Popen([sys.argv[2], "--no-env-file", "run", str(repo / "packages/backend/test/probes/browser-fixture.ts"), sys.argv[1]], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
info = None
try:
    info = json.loads(fixture.stdout.readline())
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=sys.argv[3])
        context = browser.new_context(viewport={"width": 1100, "height": 900})
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(info["base"] + "/login")
        page.get_by_label("用户名", exact=True).fill("admin")
        page.get_by_label("密码", exact=True).fill("admin123")
        page.get_by_role("button", name="登录", exact=True).click()
        page.wait_for_url("**/chat**")
        models = context.request.get(info["control"] + "/prepare").json()["models"]
        assert context.request.put(info["base"] + "/api/settings/models", data=models).ok
        workspace = info["workspaces"][0]
        sid = context.request.post(info["base"] + "/api/sessions", data={"workspace": workspace}).json()["data"]["sessionId"]
        url = info["base"] + f"/chat?workspace={workspace}&sessionId={sid}"
        page.goto(url)
        editor = page.locator('[contenteditable="true"]')
        expect(editor).to_be_visible()
        editor.fill("browser-scroll")
        editor.press("Enter")
        expect(page.get_by_text("流式滚动 99：测试消息跟随。", exact=True)).to_be_visible()
        # 使用已有列表的特征选择器，避免为了测试改动生产 DOM。
        scroller = page.get_by_label("聊天消息", exact=True)
        expect(scroller).to_have_count(1)
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        page.set_viewport_size({"width": 1100, "height": 600})
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle(), timeout=3000)
        print("SCROLL_STEP viewport resize keeps bottom", flush=True)
        # 即使只上翻一点也应尊重用户意图，不因仍位于旧60px阈值内被拉回。
        box = scroller.bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 80)
        page.mouse.wheel(0, -24)
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop >= 10", arg=scroller.element_handle())
        paused = scroller.evaluate("node => node.scrollTop")
        context.request.get(info["control"] + "/release")
        expect(page.get_by_text("流式滚动 140：持续追加内容。", exact=True)).to_be_attached()
        assert abs(scroller.evaluate("node => node.scrollTop") - paused) < 2, "stream stole the user's scroll position"
        page.get_by_title("回到底部", exact=True).click()
        expect(page.get_by_text("流式滚动 239：持续追加内容。", exact=True)).to_be_attached()
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        editor.fill("编辑草稿\n" * 9)
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        editor.fill("")
        page.set_viewport_size({"width": 1100, "height": 900})
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        editor.fill("再次编辑\n" * 6)
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        editor.fill("")
        page.wait_for_function("node => node.scrollHeight - node.clientHeight - node.scrollTop < 2", arg=scroller.element_handle())
        print("SCROLL_STEP user pause + resume + composer resize + final tail", flush=True)
        page.screenshot(path="D:/hjx/pi-agent-review-temp/scroll-follow.png")
        assert not errors, errors
        print("SCROLL_ACCEPTANCE_PASS", flush=True)
        browser.close()
finally:
    if info:
        try:
            urllib.request.urlopen(info["control"] + "/release", timeout=3).close()
            urllib.request.urlopen(info["control"] + "/stop", timeout=3).close()
        except OSError:
            pass
    try:
        fixture.wait(timeout=8)
    except subprocess.TimeoutExpired:
        fixture.kill()

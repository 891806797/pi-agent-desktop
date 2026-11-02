"""长问卷滚动回归；参数同 browser_acceptance.py，使用隔离临时数据。"""
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
        context = browser.new_context(viewport={"width": int(sys.argv[4]) if len(sys.argv) > 4 else 1100, "height": int(sys.argv[5]) if len(sys.argv) > 5 else 900})
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
        editor.fill("browser-question-long")
        editor.press("Enter")
        expect(page.get_by_text("问题 1 / 8", exact=True)).to_be_visible()
        dock = page.get_by_text("问题 1 / 8", exact=True).locator("xpath=../..")
        content = dock.locator(":scope > div").nth(1)
        group = dock.locator("xpath=../..")
        outer = dock.locator("xpath=..")
        height = page.get_by_label("消息输入区", exact=True).locator("xpath=..").evaluate("el => el.clientHeight")
        assert group.evaluate("el => getComputedStyle(el).overflowY") not in ["auto", "scroll"], "approval outer still scrolls"
        assert dock.evaluate("el => el.getBoundingClientRect().height") <= height * 0.7 + 1
        assert content.evaluate("el => el.scrollHeight > el.clientHeight"), "question content must scroll"
        before = dock.bounding_box()
        header_before = dock.locator(":scope > div").first.bounding_box()
        footer_before = dock.locator(":scope > div").last.bounding_box()
        content.hover()
        page.mouse.wheel(0, 10000)
        page.wait_for_function("el => el.scrollTop > 0", arg=content.element_handle())
        assert group.evaluate("el => el.scrollTop") == outer.evaluate("el => el.scrollTop") == dock.evaluate("el => el.scrollTop") == 0
        assert dock.bounding_box() == before
        assert dock.locator(":scope > div").first.bounding_box() == header_before
        assert dock.locator(":scope > div").last.bounding_box() == footer_before
        page.screenshot(path=f"D:/hjx/pi-agent-review-temp/question-{page.viewport_size['width']}.png")
        for index in range(8):
            page.get_by_text("选项 40", exact=True).click()
            page.get_by_role("button", name="完成" if index == 7 else "下一题", exact=True).click()
        expect(page.get_by_role("button", name="提交", exact=True)).to_be_enabled()
        page.get_by_role("button", name="提交", exact=True).click()
        expect(page.get_by_text("回顾回答", exact=True)).to_have_count(0)
        print("QUESTION_ACCEPTANCE_PASS: outer bounded to 70%, only body scrolls, header/footer fixed, all eight answers submitted", flush=True)
        assert not errors, errors

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

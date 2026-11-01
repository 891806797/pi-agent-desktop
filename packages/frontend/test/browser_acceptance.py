"""运行：python test/browser_acceptance.py <已编译的 pi-agent exe>。不接触开发数据。"""
import json
import pathlib
import subprocess
import sys
import urllib.request
from playwright.sync_api import sync_playwright, expect

repo = pathlib.Path(__file__).resolve().parents[3]
fixture = subprocess.Popen(
    [sys.argv[2] if len(sys.argv) > 2 else "bun", "--no-env-file", "run", str(repo / "packages/backend/test/probes/browser-fixture.ts"), sys.argv[1]],
    cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
)
info = None
try:
    info = json.loads(fixture.stdout.readline())
    print("BROWSER_STEP fixture ready", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=sys.argv[3] if len(sys.argv) > 3 else None)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        errors = []
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(info["base"] + "/login", wait_until="networkidle")
        page.get_by_label("用户名", exact=True).fill("admin")
        page.get_by_label("密码", exact=True).fill("admin123")
        page.get_by_role("button", name="登录", exact=True).click()
        page.wait_for_url("**/chat?workspace=*")
        print("BROWSER_STEP logged in", flush=True)
        models = json.load(urllib.request.urlopen(info["control"] + "/prepare"))["models"]
        settings = context.request.put(info["base"] + "/api/settings/models", data=models)
        assert settings.ok, settings.text()
        workspace = info["workspaces"][0]
        def create(ws):
            r = context.request.post(info["base"] + "/api/sessions", data={"workspace": ws}).json()
            assert r["ok"], r
            return r["data"]["sessionId"]
        sid = create(workspace)
        sid_b = create(info["workspaces"][1])
        headers_b = {"x-session-id": sid_b, "x-workspace-dir": info["workspaces"][1]}
        assert context.request.post(info["base"] + "/api/session/messages", headers=headers_b, data={"text": "B会话定位"}).ok
        print("BROWSER_STEP sessions ready", flush=True)
        headers = {"x-session-id": sid, "x-workspace-dir": workspace}
        model_change = context.request.put(info["base"] + "/api/session/model", headers=headers, data={"provider": "fixture", "modelId": "browser-fixture"})
        assert model_change.ok, model_change.text()
        assert context.request.put(info["base"] + "/api/session/run-mode", headers=headers, data={"mode": "safe"}).ok
        url = info["base"] + f"/chat?workspace={workspace}&sessionId={sid}"
        # SSE 是持续请求，不能等待 networkidle；改以可见且可输入的编辑器验收就绪。
        page.goto(url, wait_until="domcontentloaded")
        expect(page.locator('[contenteditable="true"]')).to_be_visible()
        pages = [page, context.new_page(), context.new_page()]
        for tab in pages[1:]:
            tab.on("pageerror", lambda error: errors.append(str(error)))
            tab.goto(url, wait_until="domcontentloaded")
            expect(tab.locator('[contenteditable="true"]')).to_be_visible()
        def send(text):
            editor = page.locator('[contenteditable="true"]')
            editor.fill(text)
            editor.press("Enter")
            expect(editor).to_have_text("")
        send("browser-permission")
        print("BROWSER_STEP permission run started", flush=True)
        # 工具尚未触发就切走；后台产生审批后，返回重放仍有效的卡片。
        page.get_by_title("project-b\n", exact=False).click()
        page.get_by_role("button", name="B会话定位", exact=True).click()
        assert "sessionId=" + sid_b in page.url
        expect(page.get_by_text("B会话定位", exact=True).last).to_be_visible()
        expect(page.get_by_role("button", name="允许", exact=True)).to_have_count(0)
        urllib.request.urlopen(info["control"] + "/release").close()
        for tab in pages[1:]:
            expect(tab.get_by_role("button", name="允许", exact=True)).to_be_visible()
        assert "sessionId=" + sid_b in page.url
        page.get_by_title("project-a\n", exact=False).click()
        page.get_by_role("button", name="browser-permission", exact=True).click()
        assert "sessionId=" + sid in page.url
        expect(page.get_by_role("button", name="允许", exact=True)).to_be_visible()
        approval_before = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["pendingApprovals"]
        urllib.request.urlopen(info["control"] + "/restart").close()
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_role("button", name="允许", exact=True)).to_be_visible()
        approval_after = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["pendingApprovals"]
        assert approval_after == approval_before
        print("BROWSER_STEP permission restored after process restart", flush=True)
        page.get_by_role("button", name="允许", exact=True).click()
        for tab in pages:
            expect(tab.get_by_role("button", name="允许", exact=True)).to_have_count(0)
            expect(tab.get_by_text("浏览器验收已完成", exact=True)).to_be_visible()
            stats = tab.locator('dl[aria-label="会话统计"]')
            expect(stats).to_contain_text("80.0%")
            expect(stats).to_contain_text("2.0K")
            expect(stats).to_contain_text("256")
        send("browser-question")
        for tab in pages:
            expect(tab.get_by_text("浏览器验收选择", exact=True)).to_be_visible()
        question_before = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["pendingApprovals"]
        urllib.request.urlopen(info["control"] + "/restart").close()
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text("浏览器验收选择", exact=True)).to_be_visible()
        question_after = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["pendingApprovals"]
        assert question_after == question_before
        print("BROWSER_STEP question restored after process restart", flush=True)
        # 由已渲染选项定位，后续断言三页统一清卡。
        page.get_by_text("继续验收", exact=True).click()
        page.get_by_role("button", name="完成", exact=True).click()
        page.get_by_role("button", name="提交", exact=True).click()
        for tab in pages:
            expect(tab.get_by_text("浏览器验收选择", exact=True)).to_have_count(0)
        send("browser-thinking")
        expect(page.get_by_text("浏览器验收等待中", exact=True)).to_be_visible()
        page.get_by_title("project-b\n", exact=False).click()
        page.get_by_role("button", name="B会话定位", exact=True).click()
        expect(page.get_by_text("浏览器验收等待中", exact=True)).to_have_count(0)
        page.get_by_title("project-a\n", exact=False).click()
        page.get_by_role("button", name="browser-permission", exact=True).click()
        expect(page.get_by_text("浏览器验收等待中", exact=True)).to_be_visible()
        send("排队验收消息")
        expect(page.get_by_text("排队验收消息", exact=True)).to_be_visible()
        page.get_by_role("button", name="立即发送", exact=True).click()
        expect(page.get_by_role("menuitem", name="不停止当前运行，尽快切入", exact=False)).to_be_visible()
        page.get_by_role("menuitem", name="停止当前运行后发送", exact=False).click()
        for tab in pages:
            expect(tab.get_by_text("排队验收消息", exact=True)).to_be_visible()
            expect(tab.get_by_role("button", name="立即发送", exact=True)).to_have_count(0)
        # 干净会话也有可用的原生命令；选择只插入草稿，参数仍可继续输入。
        editor = page.locator('[contenteditable="true"]')
        editor.fill("/")
        expect(page.get_by_text("/new", exact=True)).to_be_visible()
        expect(page.get_by_text("/compact", exact=True)).to_be_visible()
        page.get_by_text("/compact", exact=True).click()
        expect(editor).to_have_text("/compact ")
        assert "sessionId=" + sid in page.url
        editor.fill("")
        send("browser-long-read")
        expand = page.get_by_role("button", name="展开全部", exact=False).last
        expect(expand).to_be_visible()
        expand.click()
        output = page.get_by_text("WEB_TOOL_OUTPUT_TAIL", exact=False).last
        expect(output).to_be_attached()
        expect(output).to_have_css("white-space", "pre-wrap")
        assert "\nline 190:" in output.text_content(), "tool output lost source newlines"
        scrollable = output.locator("xpath=ancestor::*[contains(@class, 'overflow-auto')][1]")
        assert scrollable.evaluate("el => el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)")
        scrollable.evaluate("el => el.scrollTop = el.scrollHeight")
        # 折叠标题可通过键盘操作，展开状态对辅助技术可见。
        disclosure = page.get_by_role("button", name="read(long.txt)", exact=True)
        expect(disclosure).to_have_attribute("aria-expanded", "false")
        disclosure.focus()
        disclosure.press("Enter")
        expect(disclosure).to_have_attribute("aria-expanded", "true")
        page.screenshot(path=str(pathlib.Path(sys.argv[1]).with_suffix(".png")), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        expect(editor).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "mobile horizontal overflow"
        page.get_by_role("button", name="打开项目与会话", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.set_viewport_size({"width": 1024, "height": 844})
        expect(page.get_by_role("dialog")).to_have_count(0)
        editor.click()
        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="打开项目与会话", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.get_by_role("dialog").get_by_role("button", name="browser-permission", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(editor).to_be_visible()
        page.screenshot(path=str(pathlib.Path(sys.argv[1]).with_suffix(".mobile.png")), full_page=True)
        page.set_viewport_size({"width": 1024, "height": 844})
        # SDK 手动压缩也计入会话累计，压缩后的上下文不能继续显示旧百分比。
        before = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["metrics"]
        editor.fill("/compact ")
        with page.expect_response(lambda response: response.url.endswith("/api/session/messages") and response.request.method == "POST") as compact_request:
            editor.press("Enter")
        compact_response = compact_request.value
        assert compact_response.ok, compact_response.text()
        expect(editor).to_have_text("")
        for tab in pages:
            expect(tab.locator('dl[aria-label="会话统计"]')).to_contain_text("待更新")
        after = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["metrics"]
        # SDK 可分多次总结历史与 turn 前缀，累计应包含每次模型请求。
        added_input = after["inputTokens"] - before["inputTokens"]
        assert added_input > 0 and added_input % 1024 == 0, (before, after)
        assert after["outputTokens"] - before["outputTokens"] == added_input // 1024 * 128, (before, after)
        assert after["contextUsage"]["percent"] is None
        tab = pages[1]
        tab.reload(wait_until="domcontentloaded")
        expect(tab.locator('dl[aria-label="会话统计"]')).to_contain_text("待更新")
        restored = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["metrics"]
        assert restored == after
        send("压缩后继续")
        for tab in pages:
            expect(tab.locator('dl[aria-label="会话统计"]')).not_to_contain_text("待更新")
        # 尾部空格表示补全已完成；Enter 才提交命令。
        send("/new ")
        assert "sessionId=" not in page.url
        editor.fill("/")
        expect(page.get_by_text("/new", exact=True)).to_be_visible()
        expect(page.get_by_text("/compact", exact=True)).to_be_visible()
        assert not errors, errors
        print("BROWSER_ACCEPTANCE_PASS: login + three tabs + replay + approvals + questions + queue dispatch + native commands + complete long output + keyboard disclosure + mobile + TUI metrics + compaction/reload; no pageerror")
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
    if fixture.poll() is not None and fixture.stderr:
        stderr = fixture.stderr.read()
        if stderr:
            print(stderr, file=sys.stderr)

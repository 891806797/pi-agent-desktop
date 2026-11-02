"""运行：python test/browser_acceptance.py <已编译的 pi-agent exe>。不接触开发数据。"""
import json
import pathlib
import re
import subprocess
import sys
import urllib.request
from urllib.parse import urlparse, parse_qs
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
        # 首次使用没有项目时留在聊天页，设置页返回也不能形成跳转循环。
        page.route("**/api/workspaces", lambda route: route.fulfill(json={"ok": True, "data": {"workspaces": []}}))
        page.goto(info["base"] + "/login", wait_until="networkidle")
        page.get_by_label("用户名", exact=True).fill("admin")
        page.get_by_label("密码", exact=True).fill("admin123")
        page.get_by_role("button", name="登录", exact=True).click()
        expect(page.get_by_role("heading", name="选择项目，开始聊天")).to_be_visible()
        expect(page).to_have_url(info["base"] + "/chat")
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_role("button", name="选择项目文件夹", exact=True)).to_be_visible()
        page.goto(info["base"] + "/settings", wait_until="domcontentloaded")
        page.get_by_role("button", name="返回聊天").click()
        page.get_by_role("button", name="选择项目文件夹", exact=True).click()
        expect(page.get_by_role("dialog", name="选择项目根目录")).to_be_visible()
        page.keyboard.press("Escape")
        page.unroute("**/api/workspaces")
        initial_reads = []
        page.on("request", lambda request: initial_reads.append(request.url) if request.method == "GET" else None)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_url("**/chat?workspace=*")
        expect(page.get_by_title("选择模型", exact=True)).to_have_text("无可用模型")
        assert sum(url.endswith("/api/workspaces") for url in initial_reads) == 1, initial_reads
        assert sum(url.endswith("/api/models") for url in initial_reads) == 1, initial_reads
        print("BROWSER_STEP logged in", flush=True)
        expect(page.get_by_title("选择模型", exact=True)).to_have_text("无可用模型")
        models = json.load(urllib.request.urlopen(info["control"] + "/prepare"))["models"]
        settings = context.request.put(info["base"] + "/api/settings/models", data=models)
        assert settings.ok, settings.text()
        # Provider 表单从真实配置加载，增删、思考能力和默认值保存后仍能完整回显。
        page.goto(info["base"] + "/settings", wait_until="domcontentloaded")
        expect(page.get_by_role("heading", name="模型配置", exact=True)).to_be_visible()
        expect(page.locator("textarea")).to_have_count(0)
        page.get_by_role("button", name="添加 Provider", exact=True).click()
        provider_form = page.get_by_role("region", name="Provider 2", exact=True)
        provider_form.get_by_label("Provider 标识", exact=True).fill("second-provider")
        provider_form = page.get_by_role("region", name="Provider second-provider", exact=True)
        provider_form.get_by_label("API 地址 · baseUrl", exact=True).fill(models["providers"]["fixture"]["baseUrl"])
        provider_form.get_by_label("API Key", exact=True).fill("fixture-key")
        model_form = provider_form.get_by_role("group", name="模型 未命名", exact=True)
        model_form.get_by_label("模型 ID", exact=True).fill("second-model")
        model_form = provider_form.get_by_role("group", name="模型 second-model", exact=True)
        model_form.get_by_label("上下文窗口 · contextWindow", exact=True).fill("64000")
        model_form.get_by_label("最大输出 · maxTokens", exact=True).fill("4096")
        expect(model_form.get_by_label("默认思考强度", exact=True)).to_have_count(0)
        model_form.get_by_role("switch", name="开启思考模式", exact=True).click()
        model_form.get_by_role("button", name="支持 minimal", exact=True).click()
        model_form.get_by_role("button", name="支持 xhigh", exact=True).click()
        model_form.get_by_role("combobox", name="默认思考强度", exact=True).click()
        page.get_by_role("option", name="高 · high", exact=True).click()
        page.get_by_role("button", name="保存配置", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("配置已保存")
        stored = context.request.get(info["base"] + "/api/settings/models").json()["data"]["models"]
        second = stored["providers"]["second-provider"]["models"][0]
        assert second["name"] == second["id"] == "second-model" and second["contextWindow"] == 64000 and second["maxTokens"] == 4096, second
        assert second["thinkingLevelMap"] == {"minimal": None, "xhigh": "xhigh"} and second["defaultThinkingLevel"] == "high", second
        page.reload(wait_until="domcontentloaded")
        provider_form = page.get_by_role("region", name="Provider second-provider", exact=True)
        expect(provider_form.get_by_role("combobox", name="默认思考强度", exact=True)).to_have_text("高 · high")
        expect(provider_form.get_by_role("button", name="支持 minimal", exact=True)).to_have_attribute("aria-pressed", "false")
        expect(provider_form.get_by_role("button", name="支持 xhigh", exact=True)).to_have_attribute("aria-pressed", "true")
        page.screenshot(path="D:/hjx/pi-agent-review-temp/model-settings-eye.png", full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path="D:/hjx/pi-agent-review-temp/model-settings-mobile.png", full_page=True)
        page.set_viewport_size({"width": 1440, "height": 1000})
        provider_form.get_by_role("button", name="添加模型", exact=True).click()
        provider_form.get_by_role("button", name="删除模型 未命名", exact=True).click()
        page.get_by_role("button", name="删除 Provider second-provider", exact=True).click()
        page.get_by_role("button", name="保存配置", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("配置已保存")
        assert context.request.put(info["base"] + "/api/settings/models", data=models).ok
        inherited = json.loads(json.dumps(models))
        protocol = inherited["providers"]["fixture"].pop("api")
        for model in inherited["providers"]["fixture"]["models"]:
            model["api"] = protocol
            model["thinkingLevelMap"] = {"minimal": "tiny"}
        assert context.request.put(info["base"] + "/api/settings/models", data=inherited).ok
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_role("combobox", name="API 协议", exact=True)).to_have_text("按模型配置 / 默认")
        page.get_by_role("button", name="支持 minimal", exact=True).click()
        page.get_by_role("button", name="支持 minimal", exact=True).click()
        page.get_by_role("button", name="保存配置", exact=True).click()
        expect(page.get_by_role("status")).to_contain_text("配置已保存")
        assert context.request.get(info["base"] + "/api/settings/models").json()["data"]["models"]["providers"]["fixture"]["models"][0]["thinkingLevelMap"]["minimal"] == "tiny"
        assert context.request.put(info["base"] + "/api/settings/models", data=models).ok
        page.get_by_role("button", name="返回聊天", exact=True).click()
        # 色调循环、图标与页面同步，刷新仍保留；不使用宿主系统主题覆盖选择。
        theme_tab = context.new_page()
        theme_tab.goto(page.url, wait_until="domcontentloaded")
        for current, following, theme, icon in [("护眼", "明亮", "light", "sun"), ("明亮", "暗黑", "dark", "moon"), ("暗黑", "护眼", "eye", "leaf")]:
            page.get_by_role("button", name=f"当前{current}色调，切换为{following}", exact=True).click()
            expect(page.locator("html")).to_have_attribute("data-theme", theme)
            expect(theme_tab.locator("html")).to_have_attribute("data-theme", theme)
            expect(page.locator(f"button svg.lucide-{icon}")).to_have_count(1)
            if theme != "eye":
                page.get_by_title("设置", exact=True).click()
                page.screenshot(path=f"D:/hjx/pi-agent-review-temp/model-settings-{theme}.png", full_page=True)
                page.get_by_role("button", name="返回聊天", exact=True).click()
            page.reload(wait_until="domcontentloaded")
            expect(page.locator("html")).to_have_attribute("data-theme", theme)
        theme_tab.close()
        # 拖拽上下限、键盘、刷新记忆和窗口缩窄钳制；轴独立占位不覆盖侧栏滚动条。
        handle = page.get_by_role("separator", name="调整会话列表宽度", exact=True)
        box = handle.bounding_box()
        page.mouse.move(box["x"] + 4, box["y"] + 80)
        page.mouse.down()
        page.mouse.move(1000, box["y"] + 80, steps=12)
        page.mouse.up()
        expect(handle).to_have_attribute("aria-valuenow", "520")
        handle.press("Home")
        expect(handle).to_have_attribute("aria-valuenow", "280")
        handle.press("ArrowRight")
        expect(handle).to_have_attribute("aria-valuenow", "288")
        page.reload(wait_until="domcontentloaded")
        expect(handle).to_have_attribute("aria-valuenow", "288")
        handle.press("End")
        page.set_viewport_size({"width": 800, "height": 1000})
        expect(handle).to_have_attribute("aria-valuenow", "352")
        assert page.locator("main").evaluate("node => getComputedStyle(node).borderTopLeftRadius") == "0px"
        page.set_viewport_size({"width": 1440, "height": 1000})
        handle.dblclick()
        expect(handle).to_have_attribute("aria-valuenow", "344")
        print("BROWSER_STEP provider forms + native thinking settings + three themes + sidebar drag limits/keyboard/persistence", flush=True)
        workspace = info["workspaces"][0]
        def create(ws):
            r = context.request.post(info["base"] + "/api/sessions", data={"workspace": ws}).json()
            assert r["ok"], r
            return r["data"]["sessionId"]
        page.reload(wait_until="domcontentloaded")
        model_button = page.get_by_title("选择模型", exact=True)
        thinking_button = page.get_by_title("选择思考强度", exact=True)
        expect(model_button).to_be_enabled()
        expect(thinking_button).to_be_enabled()
        expect(model_button).to_have_text("fixture · browser-fixture")
        model_button.click()
        page.get_by_role("button", name="fixture · browser-fixture", exact=True, pressed=True).click()
        expect(model_button).to_have_text("fixture · browser-fixture")
        thinking_button.click()
        thinking_search = page.get_by_placeholder("搜索…", exact=True)
        thinking_search.fill("high")
        thinking_search.press("Enter")
        try:
            expect(thinking_button).to_have_text("思考：high")
        except AssertionError:
            print("PREFERENCES_DIAGNOSTIC", {"errors": errors, "defaults": context.request.get(info["base"] + "/api/settings/defaults").json(), "alerts": page.get_by_role("alert").all_text_contents(), "search": thinking_search.count(), "options": page.locator("button").all_text_contents()}, flush=True)
            raise
        assert "sessionId=" not in page.url
        draft_editor = page.locator('[contenteditable="true"]')
        draft_editor.fill("first-message-creates-session")
        draft_editor.press("Enter")
        expect(draft_editor).to_have_text("")
        draft_sid = parse_qs(urlparse(page.url).query)["sessionId"][0]
        prefs = context.request.get(info["base"] + "/api/settings/defaults").json()["data"]
        assert prefs["model"]["modelId"] == "browser-fixture" and prefs["thinkingLevel"] == "high", prefs
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_title("选择思考强度", exact=True)).to_have_text("思考：high")
        before_settings = page.url
        page.get_by_title("设置", exact=True).click()
        page.get_by_role("button", name="返回聊天", exact=True).click()
        expect(page).to_have_url(before_settings)
        footer = page.locator('p[title^="本次响应用量"]').first
        expect(footer).to_contain_text("缓存命中率 80.0%")
        expect(footer.locator("time")).to_have_text(re.compile(r"^\d{2}:\d{2}:\d{2}$"))
        expect(footer.locator("time")).to_have_attribute("title", re.compile(r"北京时间$"))
        print("BROWSER_STEP draft selectors persist and first send creates/selects session with chosen settings", flush=True)
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
            try:
                expect(editor).to_have_text("")
            except AssertionError:
                print("BROWSER_SEND_DIAGNOSTIC", {"page_errors": errors, "alerts": page.get_by_role("alert").all_text_contents(), "history": context.request.get(info["base"] + "/api/session/messages", headers=headers).json(), "buttons": page.evaluate("() => [...document.querySelectorAll('button')].filter(b=>b.title.includes('发送')).map(b=>({title:b.title,disabled:b.disabled}))")}, flush=True)
                raise
        send("browser-permission")
        print("BROWSER_STEP permission run started", flush=True)
        # 工具尚未触发就切走；后台产生审批后，返回重放仍有效的卡片。
        page.get_by_title("project-b\n", exact=False).click()
        expect(page).to_have_url(info["base"] + f"/chat?workspace={info['workspaces'][1]}&sessionId={sid_b}")
        assert "sessionId=" + sid_b in page.url
        expect(page.get_by_text("B会话定位", exact=True).last).to_be_visible()
        expect(page.get_by_role("button", name="允许", exact=True)).to_have_count(0)
        urllib.request.urlopen(info["control"] + "/release").close()
        for tab in pages[1:]:
            expect(tab.get_by_role("button", name="允许", exact=True)).to_be_visible()
        page.get_by_role("button", name=re.compile(r"^待处理 \d+$")).click()
        expect(page.get_by_role("dialog").get_by_text("browser-permission", exact=True)).to_be_visible()
        page.get_by_role("dialog").get_by_label("关闭", exact=True).click()
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
        expect(page.get_by_title("选择发送模式", exact=True)).to_have_text("发送：排队")
        expect(page.get_by_label("排队切入方式", exact=True)).to_have_count(0)
        with page.expect_request(lambda request: request.url.endswith("/api/session/messages") and request.method == "POST") as queued_request:
            send("排队验收消息")
        assert queued_request.value.post_data_json["behavior"] == "followUp"
        send("删除验收消息")
        queued_list = page.get_by_role("list", name="待发送消息", exact=True)
        queued_row = queued_list.get_by_role("listitem").filter(has_text="排队验收消息")
        expect(queued_row.get_by_role("button")).to_have_count(2)
        delete_row = queued_list.get_by_role("listitem").filter(has_text="删除验收消息")
        delete_row.get_by_role("button", name="删除这条待消息", exact=True).click()
        for tab in pages:
            expect(tab.get_by_text("删除验收消息", exact=True)).to_have_count(0)
        page.get_by_title("选择发送模式", exact=True).click()
        expect(page.get_by_placeholder("搜索发送模式…", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="排队发送", exact=True)).to_be_visible()
        page.locator('button[aria-label="直接发送"][aria-pressed]').click()
        expect(page.get_by_title("选择发送模式", exact=True)).to_have_text("发送：直接")
        with page.expect_request(lambda request: request.url.endswith("/api/session/messages") and request.method == "POST") as direct_request:
            send("直接模式验收消息")
        assert direct_request.value.post_data_json["behavior"] == "steer"
        expect(queued_list.get_by_text("直接模式验收消息", exact=True)).to_have_count(0)
        queued_state = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["queue"]
        assert "排队验收消息" in queued_state["followUp"] and "直接模式验收消息" not in queued_state["followUp"], queued_state
        composer = page.get_by_role("group", name="消息输入区", exact=True)
        composer.screenshot(path=str(pathlib.Path(sys.argv[1]).with_name("queue-composer-desktop.png")))
        page.set_viewport_size({"width": 390, "height": 844})
        expect(queued_row.get_by_role("button", name="直接发送", exact=True)).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "queued composer overflows mobile"
        composer.screenshot(path=str(pathlib.Path(sys.argv[1]).with_name("queue-composer-mobile.png")))
        page.set_viewport_size({"width": 1440, "height": 1000})
        queued_row.get_by_role("button", name="直接发送", exact=True).click()
        expect(page.get_by_role("list", name="待发送消息", exact=True)).to_have_count(0)
        urllib.request.urlopen(info["control"] + "/release").close()
        for tab in pages:
            expect(tab.get_by_text("排队验收消息", exact=True)).to_be_visible()
            expect(tab.get_by_role("list", name="待发送消息", exact=True)).to_have_count(0)
        print("BROWSER_STEP composer modes + direct queue action + delete + three-tab synchronization + desktop/mobile layout", flush=True)
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
        # 最终模型失败保留可操作 issue，重启后不擅自重新请求；一页继续，全页清除旧操作。
        send("browser-fail")
        for tab in pages:
            expect(tab.get_by_role("button", name="继续生成", exact=True)).to_be_visible()
        failed_issue = context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["issue"]
        urllib.request.urlopen(info["control"] + "/restart").close()
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_role("button", name="继续生成", exact=True)).to_be_visible()
        assert context.request.get(info["base"] + "/api/session/messages", headers=headers).json()["data"]["issue"] == failed_issue
        page.get_by_role("button", name="继续生成", exact=True).click()
        for tab in pages:
            expect(tab.get_by_role("button", name="继续生成", exact=True)).to_have_count(0)
        print("BROWSER_STEP failed round restored and explicitly continued", flush=True)

        # 会话管理通过真实 UI 执行，其他页面无需刷新即可同步。
        managed_sid = create(workspace)
        catalog = context.request.get(info["base"] + "/api/sessions", params={"workspace": workspace}).json()["data"]
        managed = next(row for row in catalog["sessions"] if row["sessionId"] == managed_sid)
        assert context.request.patch(info["base"] + f"/api/sessions/{managed_sid}", data={"name": "管理验收", "expectedRevision": managed["revision"]}).ok
        for tab in pages:
            expect(tab.get_by_role("button", name="管理验收", exact=True)).to_be_visible()
        page.get_by_role("button", name="管理会话 管理验收", exact=True).click()
        page.get_by_role("menuitem", name="重命名", exact=True).click()
        page.get_by_label("会话名称", exact=True).fill("统一新名称")
        page.get_by_role("button", name="保存名称", exact=True).click()
        for tab in pages:
            expect(tab.get_by_role("button", name="统一新名称", exact=True)).to_be_visible()
        page.get_by_role("button", name="管理会话 统一新名称", exact=True).click()
        page.get_by_role("menuitem", name="归档会话", exact=True).click()
        for tab in pages:
            expect(tab.get_by_role("button", name="统一新名称", exact=True)).to_have_count(0)
        page.get_by_role("button", name="归档", exact=True).click()
        expect(page.get_by_role("button", name="统一新名称", exact=True)).to_be_visible()
        page.get_by_role("button", name="管理会话 统一新名称", exact=True).click()
        page.get_by_role("menuitem", name="取消归档", exact=True).click()
        page.get_by_role("button", name="归档", exact=True).click()
        page.get_by_label("搜索会话", exact=True).fill("统一新名称")
        expect(page.get_by_role("button", name="统一新名称", exact=True)).to_be_visible()
        page.get_by_role("button", name="统一新名称", exact=True).click()
        expect(page).to_have_url(info["base"] + f"/chat?workspace={workspace}&sessionId={managed_sid}")
        page.get_by_role("button", name="管理会话 统一新名称", exact=True).click()
        page.get_by_role("menuitem", name="删除会话", exact=True).click()
        page.get_by_role("button", name="停止并删除会话", exact=True).click()
        for tab in pages:
            expect(tab.get_by_role("button", name="统一新名称", exact=True)).to_have_count(0)
        expect(page).to_have_url(info["base"] + f"/chat?workspace={workspace}")
        assert context.request.post(info["base"] + "/api/sessions", data={"workspace": workspace, "resumeSessionId": managed_sid}).status == 410
        page.get_by_label("搜索会话", exact=True).fill("")
        print("BROWSER_STEP rename archive search delete synchronized across three tabs", flush=True)
        # 尾部空格表示补全已完成；Enter 才提交命令。
        send("/new ")
        assert "sessionId=" not in page.url
        editor.fill("/")
        expect(page.get_by_text("/new", exact=True)).to_be_visible()
        expect(page.get_by_text("/compact", exact=True)).to_be_visible()

        # 隔离夹具使用真实 SessionUI、ApprovalManager、store 与组件，生产服务不开放测试入口。
        extension_tabs = [context.new_page(), context.new_page()]
        for tab in extension_tabs:
            tab.on("pageerror", lambda error: errors.append(str(error)))
            tab.goto(info["control"] + "/extension-test", wait_until="domcontentloaded")
            expect(tab.locator("html")).to_have_attribute("data-ready", "true")
        context.request.get(info["control"] + "/extension-exercise")
        for tab in extension_tabs:
            expect(tab.get_by_role("textbox", name="扩展编辑验收", exact=True)).to_have_value("原始\n内容")
            expect(tab.get_by_label("聊天草稿", exact=True)).to_have_value("聊天草稿保留")
        extension_tabs[0].get_by_role("textbox", name="扩展编辑验收", exact=True).fill("第一页编辑\n保留换行")
        expect(extension_tabs[1].get_by_role("textbox", name="扩展编辑验收", exact=True)).to_have_value("原始\n内容")
        extension_tabs[0].get_by_role("button", name="提交编辑内容", exact=True).click()
        for tab in extension_tabs:
            expect(tab.get_by_role("textbox", name="扩展编辑验收", exact=True)).to_have_count(0)
            expect(tab.get_by_label("聊天草稿", exact=True)).to_have_value("聊天草稿保留")
        state = context.request.get(info["control"] + "/extension-state").json()
        assert state["results"] == ["第一页编辑\n保留换行"], state
        extension_tabs[1].reload(wait_until="domcontentloaded")
        expect(extension_tabs[1].get_by_role("status")).to_contain_text("第一行\n第二行")
        extension_tabs[1].get_by_text("上方说明", exact=True).click()
        expect(extension_tabs[1].locator("pre").filter(has_text="one")).to_have_text("one\ntwo")
        context.request.get(info["control"] + "/extension-exercise")
        extension_tabs[1].get_by_role("button", name="取消", exact=True).click()
        for tab in extension_tabs:
            expect(tab.get_by_role("textbox", name="扩展编辑验收", exact=True)).to_have_count(0)
            tab.close()
        print("BROWSER_STEP extension state reload and two-page editor submit/cancel preserve independent drafts", flush=True)
        assert not errors, errors
        print("BROWSER_ACCEPTANCE_PASS: shared streams + three tabs + background attention + approvals + restart + explicit recovery + session management + queue + commands + tool rendering + mobile + metrics; no pageerror")
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

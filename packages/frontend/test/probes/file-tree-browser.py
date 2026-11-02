# Run the isolated backend fixture first: bun run packages/backend/test/probes/file-tree-server.ts <TEMP>/pi-file-browser-fixture.json
# Uses the Vite server on port 3001; only auth/models/session metadata are stubbed. File APIs use the real isolated backend.
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
fixture = json.loads((Path(os.environ['TEMP'])/'pi-file-browser-fixture.json').read_text())
for name in ['docs/new.md','docs/renamed.md','src/renamed.md','uploaded.txt']:
 (Path(fixture['workspace'])/name).unlink(missing_ok=True)
with sync_playwright() as p:
 browser = p.chromium.launch(headless=True, channel="chrome")
 page = browser.new_page(viewport={'width':1440,'height':980})
 page.set_default_timeout(8000)
 errors=[]
 page.on('pageerror',lambda error: errors.append(str(error)))
 def route_api(route):
  path=route.request.url.split('/api/',1)[1].split('?')[0]
  if path in ['files','file','file/move','file/upload','workspaces']:
   route.fulfill(response=route.fetch(url='http://127.0.0.1:'+str(fixture['port'])+'/api/'+route.request.url.split('/api/',1)[1],headers={**route.request.headers,'cookie':'pi_token='+fixture['token']})); return
  data={'auth/me':{'username':'browser-files'},'models':{'models':[]},'settings/defaults':{'model':None,'thinkingLevel':'off','runMode':'standard'},'sessions':{'sessions':[],'revision':0,'cursor':None}}.get(path,{})
  if 'events' in path:
   route.fulfill(status=200,content_type='text/event-stream',body=': test\n\n');return
  route.fulfill(json={'ok':True,'data':data})
 page.route('**/api/**',route_api)
 page.goto('http://localhost:3001/chat?workspace='+fixture['dir'])
 page.wait_for_load_state('networkidle')
 print('loaded',flush=True)
 tree=page.get_by_role('complementary',name='项目文件')
 expect(tree.get_by_role('button',name='hello.ts',exact=True)).to_be_visible()
 tree.get_by_role('button',name='hello.ts',exact=True).click()
 expect(page.locator('[data-mention]')).to_have_count(1)
 tree.get_by_role('button',name='hello.ts',exact=True).dblclick()
 print('opened editor',flush=True)
 editor=page.locator('.cm-content')
 expect(editor).to_be_visible()
 editor.click()
 page.keyboard.press('Control+End')
 page.keyboard.type('\n// browser edit')
 page.set_viewport_size({'width':900,'height':900})
 expect(editor).to_contain_text('// browser edit')
 page.set_viewport_size({'width':1440,'height':980})
 expect(editor).to_contain_text('// browser edit')
 page.keyboard.press('Control+s')
 expect(page.get_by_role('button',name='保存',exact=True)).to_be_disabled()
 assert '// browser edit' in (Path(fixture['workspace'])/'src/hello.ts').read_text()
 page.get_by_role('button',name='关闭',exact=True).last.click()
 expect(editor).to_have_count(0)
 print('saved and closed',flush=True)
 # Search keyboard navigation quotes a file into the composer.
 tree.get_by_role('textbox',name='搜索文件').fill('hello')
 expect(tree.get_by_role('button',name='hello.ts src/hello.ts')).to_be_visible()
 tree.get_by_role('textbox',name='搜索文件').press('Enter')
 expect(page.locator('[data-mention]')).to_have_count(2)
 print('search passed',flush=True)
 # Create a nested file and edit it through the automatically opened editor.
 tree.get_by_role('button',name='新建文件',exact=True).click()
 page.get_by_role('textbox',name='新建路径').fill('docs/new.md')
 page.get_by_role('button',name='创建',exact=True).click()
 expect(editor).to_be_visible()
 editor.fill('# Created')
 page.keyboard.press('Control+s')
 expect(page.get_by_role('button',name='保存',exact=True)).to_be_disabled()
 page.get_by_role('button',name='关闭',exact=True).last.click()
 assert (Path(fixture['workspace'])/'docs/new.md').read_text()=='# Created'
 print('create passed',flush=True)
 # Context menus use existing Base UI primitives.
 tree.get_by_role('button',name='new.md',exact=True).click(button='right')
 page.get_by_role('menuitem',name='重命名').click()
 page.get_by_role('textbox',name='新名称').fill('renamed.md')
 page.get_by_role('button',name='重命名',exact=True).click()
 expect(tree.get_by_role('button',name='renamed.md',exact=True)).to_be_visible()
 tree.get_by_role('button',name='renamed.md',exact=True).click(button='right')
 page.get_by_role('menuitem',name='移动到…',exact=True).click()
 page.get_by_role('textbox',name='目标目录').fill('src')
 page.get_by_role('button',name='移动',exact=True).click()
 expect(page.get_by_role('dialog')).to_have_count(0)
 assert (Path(fixture['workspace'])/'src/renamed.md').read_text()=='# Created'
 expect(tree.get_by_role('button',name='renamed.md',exact=True)).to_be_visible()
 tree.get_by_role('button',name='renamed.md',exact=True).click(button='right')
 page.get_by_role('menuitem',name='删除',exact=True).click()
 page.get_by_role('button',name='删除',exact=True).click()
 expect(page.get_by_role('dialog')).to_have_count(0)
 expect(tree.get_by_role('button',name='renamed.md',exact=True)).to_have_count(0)
 assert not (Path(fixture['workspace'])/'src/renamed.md').exists()
 tree.locator('input[type=file]').set_input_files({'name':'uploaded.txt','mimeType':'text/plain','buffer':b'uploaded content'})
 page.get_by_role('button',name='上传',exact=True).click()
 expect(page.get_by_role('dialog')).to_have_count(0)
 assert (Path(fixture['workspace'])/'uploaded.txt').read_text()=='uploaded content'
 expect(tree.get_by_role('button',name='uploaded.txt',exact=True)).to_be_visible()
 # Drag divider via keyboard and restore by double click.
 divider=page.get_by_role('separator',name='调整文件面板宽度')
 divider.focus(); divider.press('ArrowLeft')
 assert divider.get_attribute('aria-valuenow')=='296'
 divider.dblclick()
 assert divider.get_attribute('aria-valuenow')=='288'
 page.set_viewport_size({'width':390,'height':844})
 page.get_by_role('button',name='文件面板',exact=True).click()
 expect(page.get_by_role('dialog').get_by_role('textbox',name='搜索文件')).to_be_visible()
 assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
 page.get_by_role('dialog').get_by_role('button',name='hello.ts',exact=True).click()
 expect(page.get_by_role('dialog')).to_have_count(0)
 print('PASS: reference, search, edit/save, dirty draft across breakpoints, create/rename/move/delete/upload, resizing, mobile')
 assert not errors, errors
 print('pageerrors',errors)
 page.screenshot(path=os.path.join(os.environ['TEMP'],'pi-file-tree-before.png'))
 browser.close()

/** Chromium regression for the Better Sidebar viewport-host feedback loop. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', {
  paths: [process.env.DSH_TEST_NODE_MODULES || process.cwd()],
}));

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.DSH_TEST_BROWSER ? { executablePath: process.env.DSH_TEST_BROWSER } : {}),
  });
  const source = fs.readFileSync(process.env.DSH_ZOOM_CLIENT || path.join(__dirname, '../lib/client.js'), 'utf8');
  try {
    for (const level of [1, 1.1, 1.25]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.route('http://fixture.test/', route => route.fulfill({
        contentType: 'text/html',
        body: `<style>
          html,body,#root{height:100%;margin:0}
          .frame{display:flex;height:100%;overflow:hidden}
          .sidebar{width:200px}.content{flex:1;min-height:0;overflow:auto}.long{height:3000px}
          [data-dsh-panel-host]{position:fixed;inset:0;height:100vh;overflow:clip;pointer-events:none}
          [data-dsh-panel-host][data-dsh-panel-host-degraded]{position:absolute;top:0;left:0}
          .panel{position:absolute;bottom:0;height:300px;transform:translateY(102%)}
        </style><div id="root"><div class="frame"><aside class="sidebar">Sidebar</aside>
          <main class="content"><div class="long">Plugin details</div></main></div></div>`,
      }));
      await page.goto('http://fixture.test/');
      await page.evaluate(level => {
        localStorage.setItem('dsh-zoom:level', String(level));
        window.__ModuleLoader__ = { load(entry) { window.plugin = entry.factory(() => { throw Error('Unexpected dependency'); }); } };
      }, level);
      await page.addScriptTag({ content: source });
      await page.evaluate(() => {
        window.plugin.apply({ effect() {} });
        // The real sidebar mounts after zoom and checks the viewport once.
        const layer = document.createElement('div');
        layer.setAttribute('data-dsh-panel-host', '');
        layer.innerHTML = '<div class="panel">Collapsed panel</div>';
        document.body.appendChild(layer);
        requestAnimationFrame(() => {
          const rect = layer.getBoundingClientRect();
          const mismatched = Math.abs(rect.left) > 8 || Math.abs(rect.top) > 8
            || Math.abs(rect.width - innerWidth) > 8 || Math.abs(rect.height - innerHeight) > 8;
          if (!mismatched) return;
          layer.setAttribute('data-dsh-panel-host-degraded', '');
          let applied = { x: 0, y: 0 };
          const sync = () => {
            const r = layer.getBoundingClientRect();
            const rawLeft = r.left - applied.x, rawTop = r.top - applied.y;
            if (Math.abs(rawLeft) <= 1 && Math.abs(rawTop) <= 1
              && Math.abs(r.width - innerWidth) <= 1 && Math.abs(r.height - innerHeight) <= 1) {
              layer.removeAttribute('data-dsh-panel-host-degraded');
              layer.style.transform = '';
              return;
            }
            const next = { x: -rawLeft, y: -rawTop };
            if (next.x !== applied.x || next.y !== applied.y) {
              applied = next;
              layer.style.transform = `translate(${applied.x}px, ${applied.y}px)`;
            }
            requestAnimationFrame(sync);
          };
          requestAnimationFrame(sync);
        });
      });
      for (const viewport of [{ width: 1280, height: 820 }, { width: 960, height: 700 }]) {
        await page.setViewportSize(viewport);
        await page.mouse.move(500, 300);
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 10000);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        const state = await page.evaluate(() => ({
          y: scrollY,
          height: document.scrollingElement.scrollHeight,
          degraded: document.querySelector('[data-dsh-panel-host]').hasAttribute('data-dsh-panel-host-degraded'),
          contentScroll: document.querySelector('.content').scrollTop,
        }));
        assert.equal(state.y, 0, `whole page must stay fixed at zoom ${level}`);
        assert.equal(state.height, viewport.height, `document must fit at zoom ${level}`);
        assert.equal(state.degraded, false, `sidebar must not enter degraded mode at zoom ${level}`);
        assert.ok(state.contentScroll > 0, 'inner content must still scroll');
      }
      await page.close();
    }
    console.log('zoom/browser: 100%, 110%, 125%, late sidebar mount, resize and inner scrolling passed');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

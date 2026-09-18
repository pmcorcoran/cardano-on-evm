"""Portable browser settings; omit the executable to use Playwright's install."""
import os
import json
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

BROWSER_OPTIONS = {
    'headless': True,
    'args': ['--no-sandbox'],
}
if os.environ.get('BROWSER_EXECUTABLE_PATH'):
    BROWSER_OPTIONS['executable_path'] = os.environ['BROWSER_EXECUTABLE_PATH']

WALLET_LAB_URL = os.environ.get('WALLET_LAB_URL', 'http://127.0.0.1:4173').rstrip('/')
REFERENCE_APP_URL = os.environ.get('REFERENCE_APP_URL', 'http://127.0.0.1:4174').rstrip('/')


def evidence_path(name):
    out = Path(os.environ.get('BROWSER_EVIDENCE_DIR', 'evidence/local'))
    out.mkdir(parents=True, exist_ok=True)
    return str(out / name)


@asynccontextmanager
async def browser_page(name, **page_options):
    """Keep failure evidence before closing the browser, including cancellation."""
    events, blocked = [], []
    browser = context = page = None
    result = {'kind': 'browser-execution', 'test': name, 'passed': False,
              'externalRequestsDenied': os.environ.get('LOCAL_BROWSER_ONLY') == '1'}
    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(**BROWSER_OPTIONS)
            result['browserVersion'] = browser.version
            context = await browser.new_context(service_workers='block', **page_options)
            if os.environ.get('LOCAL_BROWSER_ONLY') == '1':
                async def local_only(route):
                    parsed = urlparse(route.request.url)
                    if parsed.scheme in ('http', 'https') and parsed.hostname not in ('127.0.0.1', '::1', 'localhost'):
                        blocked.append({'scheme': parsed.scheme, 'host': parsed.hostname})
                        await route.abort('blockedbyclient')
                    else:
                        await route.continue_()
                await context.route('**/*', local_only)
            await context.tracing.start(screenshots=True, snapshots=True, sources=True)
            page = await context.new_page()
            page.on('console', lambda message: events.append({'kind': 'console', 'level': message.type, 'text': message.text}))
            page.on('pageerror', lambda error: events.append({'kind': 'pageerror', 'text': str(error)}))
            yield page
            if blocked:
                raise AssertionError('Browser attempted a non-loopback request')
            result['passed'] = True
        except BaseException:
            result['failure'] = traceback.format_exc()
            if page is not None:
                try:
                    await page.screenshot(path=evidence_path(name + '-failure.png'), full_page=True)
                    Path(evidence_path(name + '-failure.html')).write_text(await page.content())
                except Exception as capture_error:
                    result['captureFailure'] = str(capture_error)
            raise
        finally:
            if context is not None:
                try:
                    await context.tracing.stop(path=evidence_path(name + '-trace.zip'))
                finally:
                    await context.close()
            if browser is not None:
                await browser.close()
            result.update(events=events, blockedRequests=blocked)
            Path(evidence_path(name + '-execution.json')).write_text(json.dumps(result, indent=2) + '\n')

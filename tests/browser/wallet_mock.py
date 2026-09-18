"""Generated CIP-30 test providers. Never represents installed wallet behavior."""
from playwright.async_api import expect

CASES = [('lace', ['lace']), ('eternl', ['eternl']), ('lace', ['lace', 'eternl']), ('eternl', ['lace', 'eternl'])]


async def install_wallets(page, installed):
    await page.add_init_script(path='.local/reference-browser-wallet.js')
    await page.add_init_script('for (const id of ["lace", "eternl"]) if (!' + str(installed).replace("'", '"') + '.includes(id)) delete window.cardano[id];')


async def choose_wallet(page, wallet, version_selector='#version'):
    assert await page.locator('#wallet').input_value() == 'lace'
    await page.locator('#wallet').select_option(wallet)
    assert await page.locator(version_selector).input_value() == ''
    assert await page.locator('#connect').inner_text() == 'Connect ' + wallet.capitalize()
    await page.locator(version_selector).fill('GENERATED-TEST-RELEASE')


async def update_wallet(page, wallet, **values):
    await page.evaluate('({wallet, values}) => Object.assign(window.walletMocks[wallet], values)', dict(wallet=wallet, values=values))


async def wait_prompt(page, wallet):
    await page.wait_for_function('(id) => !!window.walletMocks[id].resume', arg=wallet)
    assert await page.locator('#wallet').is_disabled()
    assert await page.locator('#connect').is_disabled()


async def resume_wallet(page, wallet):
    await page.evaluate('(id) => window.walletMocks[id].resume()', wallet)
    await expect(page.locator('#wallet')).to_be_enabled()


async def force_wallet_change(page, wallet):
    # Simulate selection invalidation while a provider promise is still pending.
    # Real users cannot change this disabled control during a request.
    await page.evaluate('(id) => { const s = document.getElementById("wallet"); s.value = id; s.dispatchEvent(new Event("change")); }', wallet)


async def assert_provider_isolation(page, selected, installed):
    for other in installed:
        if other != selected:
            assert await page.evaluate('(id) => window.walletMocks[id].enableCalls', other) == 0
            assert await page.evaluate('(id) => window.walletMocks[id].signCalls.length', other) == 0

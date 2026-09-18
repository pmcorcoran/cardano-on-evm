"""Wallet UI coverage with generated providers; no real-wallet acceptance claim."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import expect
from settings import browser_page, evidence_path, WALLET_LAB_URL
from wallet_mock import CASES, install_wallets, choose_wallet, update_wallet, wait_prompt, resume_wallet, force_wallet_change, assert_provider_isolation


async def main():
    results = []
    for index, (wallet, installed) in enumerate(CASES):
        captures = []
        async with browser_page('wallet_credential_' + str(index)) as page:
            await install_wallets(page, installed)

            async def capture(route):
                body = route.request.post_data_json
                assert body['walletId'] == wallet
                assert body['walletName'] == 'GENERATED ' + wallet.upper() + ' TEST PROVIDER'
                assert body['walletApiVersion'] == '1'
                assert body['walletRelease'] == 'GENERATED-TEST-RELEASE'
                assert body['userAgent'] and body['enrollment']['signature'] and body['operation']['signature']
                captures.append(body)
                await route.fulfill(json={'testData': True, 'verified': True})

            await page.route('**/lab/capture', capture)
            await page.goto(WALLET_LAB_URL)
            await choose_wallet(page, wallet)
            assert await page.locator('#credential').input_value() == 'stake'
            await page.locator('#connect').click()
            await expect(page.locator('#capture')).to_be_enabled()
            assert wallet.capitalize() in await page.locator('#status').inner_text()
            await page.locator('#capture').click()
            await expect(page.locator('#status')).to_contain_text('signatures verified')
            await page.locator('#credential').select_option('payment')
            await expect(page.locator('#status')).to_contain_text('PAYMENT')
            await page.locator('#capture').click()
            await expect(page.locator('#status')).to_contain_text('signatures verified')
            assert [item['credential'] for item in captures] == ['stake', 'payment']
            await assert_provider_isolation(page, wallet, installed)

            # Standard declined signing keeps valid state and allows retry.
            await update_wallet(page, wallet, signError={'code': 3, 'info': 'operator declined'})
            await page.locator('#capture').click()
            await expect(page.locator('#status')).to_contain_text('Signing declined')
            await expect(page.locator('#capture')).to_be_enabled()
            await update_wallet(page, wallet, signError=None)
            await page.locator('#capture').click()
            await expect(page.locator('#status')).to_contain_text('signatures verified')

            # Failed reconnection cannot reuse an earlier address or signature review.
            await update_wallet(page, wallet, enableError={'code': -3, 'info': 'test lost access'})
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('Reconnect')
            assert await page.locator('#capture').is_disabled()
            assert await page.locator('#address').input_value() == ''
            await update_wallet(page, wallet, enableError=None, rewards=[])
            await page.locator('#credential').select_option('stake')
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('no supported addresses')
            assert await page.locator('#capture').is_disabled()
            await page.locator('#credential').select_option('payment')
            await expect(page.locator('#capture')).to_be_enabled()

            # Injecting a stale credential option is rejected before a challenge/signature.
            count = await page.evaluate('window.testSignCalls.length')
            await page.evaluate("document.getElementById('address').replaceChildren(new Option('stale', 'e0'+'08'.repeat(28)))")
            await page.locator('#capture').click()
            await expect(page.locator('#status')).to_contain_text('does not match')
            assert await page.evaluate('window.testSignCalls.length') == count
            assert await page.locator('#capture').is_disabled()

            # Delayed provider connection is discarded if the selection is invalidated.
            await update_wallet(page, wallet, pause='enable')
            await page.locator('#connect').click()
            await wait_prompt(page, wallet)
            other = 'eternl' if wallet == 'lace' else 'lace'
            await force_wallet_change(page, other)
            assert await page.locator('#version').input_value() == ''
            await resume_wallet(page, wallet)
            assert await page.locator('#address').input_value() == ''
            assert await page.locator('#capture').is_disabled()
            assert other.capitalize() in await page.locator('#status').inner_text()
            if other not in installed:
                await page.locator('#connect').click()
                await expect(page.locator('#status')).to_contain_text('not installed')
                assert await page.locator('#capture').is_disabled()

            await page.locator('#wallet').select_option(wallet)
            await page.locator('#version').fill('GENERATED-TEST-RELEASE')
            await update_wallet(page, wallet, pause='addresses')
            await page.locator('#connect').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert await page.locator('#address').input_value() == ''
            assert await page.locator('#capture').is_disabled()

            # Changing selection during a delayed signature must not save stale evidence.
            await page.locator('#wallet').select_option(wallet)
            await page.locator('#version').fill('GENERATED-TEST-RELEASE')
            await page.locator('#connect').click()
            await expect(page.locator('#capture')).to_be_enabled()
            await update_wallet(page, wallet, pause='sign')
            count = len(captures)
            await page.locator('#capture').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert len(captures) == count
            assert await page.locator('#capture').is_disabled()
            results.append(dict(wallet=wallet, installed=installed, captures=len(captures), switching=True, staleResponsesRejected=True, declinedSigningRetry=True, failedReconnectClearsState=True, emptyRewards=True, metadata=True))
    result = dict(kind='browser-regression-with-generated-providers', realWallet=False, cases=results)
    Path(evidence_path('wallet-credential-ui.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


asyncio.run(main())

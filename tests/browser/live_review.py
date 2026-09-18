"""Live review coverage with generated providers/requests; no public submission."""
import asyncio
import copy
import json
import os
from pathlib import Path
from playwright.async_api import expect
from settings import browser_page, evidence_path, WALLET_LAB_URL
from wallet_mock import CASES, install_wallets, choose_wallet, update_wallet, wait_prompt, resume_wallet, force_wallet_change, assert_provider_isolation


async def main():
    requests = [json.loads(path.read_text()) for path in sorted(Path(os.environ['REVIEW_REQUESTS_DIR']).glob('*.json'))]
    base_request = next(r for r in requests if r['profile'] == 'experimental-general')
    results = []
    for index, (wallet, installed) in enumerate(CASES):
        request = dict(base_request, walletId=wallet)
        captures, listed = [], [{'request': request, 'signed': False, 'result': None}]
        async with browser_page('live_review_' + str(index), viewport={'width': 390, 'height': 844}) as page:
            await install_wallets(page, installed)
            await page.route('**/live/requests', lambda route: route.fulfill(json={'requests': listed}))

            async def capture(route):
                body = route.request.post_data_json
                assert body['walletId'] == wallet and body['walletApiVersion'] == '1'
                assert body['walletName'] == 'GENERATED ' + wallet.upper() + ' TEST PROVIDER'
                assert body['walletVersion'] == 'GENERATED-TEST-RELEASE' and body['userAgent']
                captures.append(body)
                await route.fulfill(json={'status': 'signature-verified-and-saved'})

            await page.route('**/live/signature', capture)
            await page.goto(WALLET_LAB_URL + '/live')
            await choose_wallet(page, wallet)
            await update_wallet(page, wallet, rewards=['e0' + '08' * 28])
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('does not expose')
            assert await page.locator('#sign').is_disabled()
            await update_wallet(page, wallet, rewards=[request['cardanoAddress']])
            await page.locator('#connect').click()
            await expect(page.locator('#sign')).to_be_enabled()
            assert request['operation']['sender'] in await page.locator('#context').inner_text()
            assert 'STAKE' in await page.locator('#context').inner_text()
            assert '0.0000425' in await page.locator('#context').inner_text()
            assert 'increment(1)' in await page.locator('#calls').inner_text()

            await update_wallet(page, wallet, rewards=[])
            await page.locator('#sign').click()
            await expect(page.locator('#status')).to_contain_text('Wallet account changed')
            assert await page.evaluate('window.testSignCalls.length') == 0
            assert await page.locator('#sign').is_disabled()
            await update_wallet(page, wallet, rewards=[request['cardanoAddress']])
            await page.locator('#connect').click()
            await expect(page.locator('#sign')).to_be_enabled()
            await update_wallet(page, wallet, signError={'code': 3, 'info': 'operator declined'})
            await page.locator('#sign').click()
            await expect(page.locator('#status')).to_contain_text('Signing declined')
            await expect(page.locator('#sign')).to_be_enabled()
            assert await page.evaluate('window.testSignCalls') == [{'address': request['cardanoAddress'], 'payload': request['payloadHex'][2:]}]
            await update_wallet(page, wallet, signError=None)
            await page.locator('#sign').click()
            await expect(page.locator('#status')).to_contain_text('signature verified and saved')
            assert len(captures) == 1 and await page.locator('#sign').is_disabled()
            await assert_provider_isolation(page, wallet, installed)

            # Reload unsigned state, fail a reconnect, and discard delayed responses.
            await page.locator('#refresh').click()
            await expect(page.locator('#connect')).to_be_enabled()
            await page.locator('#connect').click()
            await expect(page.locator('#sign')).to_be_enabled()
            await update_wallet(page, wallet, enableError={'code': -4, 'info': 'changed account'})
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('Reconnect')
            assert await page.locator('#sign').is_disabled()
            await update_wallet(page, wallet, enableError=None, pause='enable')
            await page.locator('#connect').click()
            await wait_prompt(page, wallet)
            other = 'eternl' if wallet == 'lace' else 'lace'
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert await page.locator('#version').input_value() == ''
            assert await page.locator('#sign').is_disabled()
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('Enrol')
            await page.locator('#wallet').select_option(wallet)
            await page.locator('#version').fill('GENERATED-TEST-RELEASE')
            await page.locator('#connect').click()
            await expect(page.locator('#sign')).to_be_enabled()
            await update_wallet(page, wallet, pause='sign')
            await page.locator('#sign').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert len(captures) == 1 and await page.locator('#sign').is_disabled()

            altered = copy.deepcopy(request); altered['payloadHex'] = '0x' + '01' * 32
            listed[:] = [{'request': altered, 'signed': False, 'result': None}]
            await page.locator('#refresh').click()
            await expect(page.locator('#status')).to_contain_text('authorization payload')
            assert await page.locator('#connect').is_disabled() and await page.locator('#sign').is_disabled()
            profiles = []
            for candidate in requests:
                if candidate['profile'] == 'experimental-general':
                    continue
                listed[:] = [{'request': candidate, 'signed': False, 'result': None}]
                await page.locator('#refresh').click()
                await expect(page.locator('#connect')).to_be_enabled()
                context = await page.locator('#context').inner_text()
                assert candidate['operation']['sender'] in context
                if candidate['profile'] == 'restricted':
                    assert 'No administrator or owner opt-out' in context
                    policy = await page.locator('#policy').inner_text()
                    assert 'cannot remove its restrictions' in policy
                    if candidate['profileDetails']['name'] == 'selectors':
                        assert 'increment(uint256)' in policy
                else:
                    assert 'owner can change modules and upgrade' in context
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                profiles.append(candidate['profileDetails']['name'])
            await page.screenshot(path=evidence_path('live-review-' + str(index) + '.png'), full_page=True)
            results.append(dict(wallet=wallet, installed=installed, profileReviews=profiles, metadata=True, exactPayload=True, staleResponsesRejected=True, declinedSigningRetry=True, failedReconnectClearsState=True, changedAccountRejected=True))
    evidence = dict(kind='browser-review-with-generated-providers', realWallet=False, liveTransactions=False, cases=results)
    Path(evidence_path('live-review-ui.json')).write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


asyncio.run(main())

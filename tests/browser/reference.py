"""Reference UI with generated providers and mocked state/submission/receipts.
No real-wallet or public-network acceptance is inferred from these tests.
"""
import asyncio
import json
from pathlib import Path
from playwright.async_api import expect
from settings import browser_page, evidence_path, REFERENCE_APP_URL
from wallet_mock import CASES, install_wallets, choose_wallet, update_wallet, wait_prompt, resume_wallet, force_wallet_change, assert_provider_isolation


async def main():
    fixture = json.loads(Path('.local/reference-browser-fixtures.json').read_text())
    results = []
    for index, (wallet, installed) in enumerate(CASES):
        submissions, enrollments, errors, states = [], [], [], {}
        async with browser_page('reference_' + str(index), viewport={'width': 390, 'height': 844}) as page:
            page.on('pageerror', lambda error: errors.append(str(error)))
            await install_wallets(page, installed)

            async def configuration(route):
                response = await route.fetch(); config = await response.json()
                config['availableModes'] = ['private', 'public', 'direct']
                await route.fulfill(json=config)

            async def enrollment(route):
                name, action = route.request.url.split('/')[-2:]
                f, body = fixture['profiles'][name], route.request.post_data_json
                if action == 'challenge':
                    assert body['address'] == fixture['address']
                    await route.fulfill(json=f['challenge'])
                else:
                    assert body['id'] == f['challenge']['id']
                    assert body['signature'] == f['signed']['signature'] and body['key'] == f['signed']['key']
                    assert body['walletId'] == wallet and body['walletApiVersion'] == '1'
                    assert body['walletName'] == 'GENERATED ' + wallet.upper() + ' TEST PROVIDER'
                    assert body['walletVersion'] == 'GENERATED-TEST-RELEASE' and body['userAgent']
                    enrollments.append(body)
                    states.setdefault('mock-' + name, dict(address=f['enrolled']['identity']['account'], nonce='0', balance='1000000000000', deposit='100000000000000', prepared=True, deployed=False))
                    await route.fulfill(json=f['enrolled'])

            async def state(route):
                await route.fulfill(json=states[route.request.post_data_json['sessionId']])

            async def submit(route):
                body = route.request.post_data_json
                assert body['authorization']['signature'] and body['operation']['signature'] != '0x'
                assert body['walletId'] == wallet and body['walletApiVersion'] == '1'
                s = states[body['sessionId']]
                assert body['operation']['sender'].lower() == s['address'].lower()
                assert int(body['operation']['nonce']) == int(s['nonce'])
                s['nonce'] = str(int(s['nonce']) + 1); s['deployed'] = True
                submissions.append(body)
                await route.fulfill(json={'status': 'submitted'})

            async def status(route):
                body = route.request.post_data_json
                await route.fulfill(json={'status': 'included', 'userOperationHash': body['hash'], 'transactionHash': '0x'+'22'*32})

            for path, handler in [('config', configuration), ('enrollment/*/*', enrollment), ('state', state), ('submit', submit), ('status', status)]:
                await page.route('**/' + path, handler)
            await page.goto(REFERENCE_APP_URL)
            await choose_wallet(page, wallet, '#wallet-version')
            await page.locator('#connect').click()
            await expect(page.locator('#enroll')).to_be_enabled()

            async def enroll_current():
                await page.locator('#enroll').click()
                await expect(page.locator('#status')).to_contain_text('predictions agree')

            for name, mode in [('general', 'public'), ('targets', 'private'), ('selectors', 'direct')]:
                await page.locator('#profile').select_option(name)
                if name != 'general':
                    assert await page.locator('#enroll').is_disabled()
                    assert 'no administrator or owner opt-out' in await page.locator('#authority').inner_text()
                    await page.locator('#policy-ack').check()
                await enroll_current()
                assert states['mock-'+name]['address'] in await page.locator('#account-state').inner_text()
                for action in ['increment', 'batch', 'transfer']:
                    await page.locator('#mode').select_option(mode)
                    await page.locator('#action').select_option(action)
                    await page.locator('#review').click()
                    await expect(page.locator('#sign')).to_be_enabled()
                    assert '0.0000425' in await page.locator('#context').inner_text()
                    if name == 'general' and action == 'increment':
                        before = await page.evaluate('window.testSignCalls.length')
                        await update_wallet(page, wallet, rewards=[])
                        await page.locator('#sign').click()
                        await expect(page.locator('#status')).to_contain_text('unavailable')
                        assert await page.evaluate('window.testSignCalls.length') == before and not submissions
                        assert await page.locator('#sign').is_disabled() and await page.locator('#enroll').is_disabled()
                        await update_wallet(page, wallet, rewards=[fixture['address']])
                        await page.locator('#connect').click()
                        await expect(page.locator('#enroll')).to_be_enabled()
                        await enroll_current()
                        await page.locator('#review').click()
                        await expect(page.locator('#sign')).to_be_enabled()
                        await page.locator('#mode').select_option('private')
                        assert await page.locator('#sign').is_disabled()
                        await page.locator('#mode').select_option(mode)
                        await page.locator('#review').click()
                        await expect(page.locator('#sign')).to_be_enabled()
                        await update_wallet(page, wallet, signError={'code': 3, 'info': 'operator declined'})
                        await page.locator('#sign').click()
                        await expect(page.locator('#status')).to_contain_text('Signing declined')
                        await expect(page.locator('#sign')).to_be_enabled()
                        await update_wallet(page, wallet, signError=None)
                    await page.locator('#sign').click()
                    await expect(page.locator('#status')).to_contain_text('included successfully')
                    assert submissions[-1]['mode'] == mode
                    assert await page.locator('#sign').is_disabled() and await page.locator('#poll').is_enabled()
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            await assert_provider_isolation(page, wallet, installed)
            assert len(submissions) == 9 and not errors, errors

            # Switching after enrollment/review clears sessions but retains receipt access.
            await page.locator('#profile').select_option('general')
            await expect(page.locator('#review')).to_be_enabled()
            await page.locator('#review').click()
            await expect(page.locator('#sign')).to_be_enabled()
            other = 'eternl' if wallet == 'lace' else 'lace'
            await page.locator('#wallet').select_option(other)
            assert await page.locator('#wallet-version').input_value() == ''
            assert await page.locator('#address').input_value() == ''
            assert await page.locator('#sign').is_disabled() and await page.locator('#review').is_disabled()
            assert await page.locator('#poll').is_visible() and await page.locator('#poll').is_enabled()
            await page.locator('#poll').click()
            await expect(page.locator('#status')).to_contain_text('included successfully')
            if other not in installed:
                await page.locator('#connect').click()
                await expect(page.locator('#status')).to_contain_text('not installed')
            await page.locator('#wallet').select_option(wallet)
            await page.locator('#wallet-version').fill('GENERATED-TEST-RELEASE')
            await page.locator('#connect').click()
            await expect(page.locator('#enroll')).to_be_enabled()
            assert await page.locator('#review').is_disabled()
            await enroll_current()
            await update_wallet(page, wallet, enableError={'code': -3, 'info': 'lost access'})
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('Reconnect')
            assert await page.locator('#address').input_value() == ''
            assert await page.locator('#enroll').is_disabled() and await page.locator('#review').is_disabled()
            await update_wallet(page, wallet, enableError=None, rewards=[])
            await page.locator('#connect').click()
            await expect(page.locator('#status')).to_contain_text('no stake address')
            assert await page.locator('#enroll').is_disabled()

            await update_wallet(page, wallet, rewards=[fixture['address']], pause='enable')
            await page.locator('#connect').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert await page.locator('#address').input_value() == ''
            assert await page.locator('#enroll').is_disabled()
            await page.locator('#wallet').select_option(wallet)
            await page.locator('#wallet-version').fill('GENERATED-TEST-RELEASE')
            await page.locator('#connect').click()
            await expect(page.locator('#enroll')).to_be_enabled()
            await update_wallet(page, wallet, pause='sign')
            count = len(enrollments)
            await page.locator('#enroll').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert len(enrollments) == count and await page.locator('#review').is_disabled()

            await page.locator('#wallet').select_option(wallet)
            await page.locator('#wallet-version').fill('GENERATED-TEST-RELEASE')
            await page.locator('#connect').click()
            await expect(page.locator('#enroll')).to_be_enabled()
            await enroll_current()
            await page.locator('#review').click()
            await expect(page.locator('#sign')).to_be_enabled()
            await update_wallet(page, wallet, pause='sign')
            await page.locator('#sign').click()
            await wait_prompt(page, wallet)
            await force_wallet_change(page, other)
            await resume_wallet(page, wallet)
            assert len(submissions) == 9 and await page.locator('#sign').is_disabled()
            assert await page.locator('#poll').is_visible()
            assert not errors, errors
            await page.screenshot(path=evidence_path('reference-' + str(index) + '.png'), full_page=True)
            results.append(dict(wallet=wallet, installed=installed, signedActions=len(submissions), enrolledProfiles=list(fixture['profiles']), metadata=True, freshEnrollmentOnSwitch=True, receiptsPreserved=True, staleResponsesRejected=True, declinedSigningRetry=True, failedReconnectClearsState=True))
    evidence = dict(kind='reference-browser-generated-providers-and-mock-network', realWallet=False, liveTransactions=False, cases=results)
    Path(evidence_path('reference-browser.json')).write_text(json.dumps(evidence, indent=2)+'\n')
    print(json.dumps(evidence))


asyncio.run(main())

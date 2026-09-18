"""Exercise failure capture with an intentionally failing local browser check."""
import asyncio
import json
import os
from pathlib import Path
from settings import browser_page, evidence_path


async def main():
    try:
        async with browser_page('intentional-failure') as page:
            await page.set_content('<!doctype html><title>Failure capture regression</title><p>Local failure capture fixture</p>')
            raise AssertionError('intentional browser failure capture regression')
    except AssertionError as error:
        assert str(error) == 'intentional browser failure capture regression'
    else:
        raise AssertionError('The intentionally failing check unexpectedly passed')
    image = Path(evidence_path('intentional-failure-failure.png'))
    assert image.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
    report = json.loads(Path(evidence_path('intentional-failure-execution.json')).read_text())
    assert report['passed'] is False
    assert 'intentional browser failure capture regression' in report['failure']
    assert Path(evidence_path('intentional-failure-trace.zip')).stat().st_size > 0
    if os.environ.get('LOCAL_BROWSER_ONLY') == '1':
        try:
            async with browser_page('intentional-external-request') as page:
                await page.set_content('<!doctype html><title>Local network guard</title>')
                assert await page.evaluate("fetch('https://sepolia.base.org', {mode:'no-cors'}).then(()=>false,()=>true)")
        except AssertionError as error:
            assert str(error) == 'Browser attempted a non-loopback request'
        else:
            raise AssertionError('Browser external request did not fail acceptance')
        blocked = json.loads(Path(evidence_path('intentional-external-request-execution.json')).read_text())
        assert blocked['passed'] is False
        assert blocked['blockedRequests'] == [{'scheme': 'https', 'host': 'sepolia.base.org'}]
    print(json.dumps({'kind': 'browser-failure-capture-regression', 'passed': True, 'screenshot': image.name, 'failureRemainedFailure': True, 'publicRpcRequestRejected': os.environ.get('LOCAL_BROWSER_ONLY') == '1'}))


asyncio.run(main())

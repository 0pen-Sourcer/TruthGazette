const { verifySource } = require('../lib/sourceVerifier');

(async () => {
  console.log('Running sourceVerifier tests...');
  let failed = 0;

  console.log('Test 1: example.com should be reachable and HTML');
  const r1 = await verifySource('https://example.com', 'Example Domain');
  console.log('Result:', r1);
  if (!r1.ok) {
    console.error('Test 1 failed'); failed++;
  }

  console.log('Test 2: non-existent domain should be unavailable');
  const r2 = await verifySource('https://this-domain-should-not-exist-abcdefg12345.com/404', '');
  console.log('Result:', r2);
  if (r2.ok) {
    console.error('Test 2 failed: expected not ok'); failed++;
  }

  if (failed > 0) {
    console.error(`${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('All tests passed');
})();
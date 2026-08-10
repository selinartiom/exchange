const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  mapIpnStatusToOrderStatus,
  signIpnPayload,
  verifyIpnSignature,
} = require('../src/payments/nowpayments');

describe('NOWPayments IPN helpers', () => {
  it('verifies signature over alphabetically sorted payload keys', () => {
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-secret';
    const payload = {
      payment_status: 'finished',
      order_id: 'abc123',
      payment_id: 42,
      nested: { z: 1, a: 2 },
    };

    const signature = signIpnPayload(payload, process.env.NOWPAYMENTS_IPN_SECRET);
    assert.equal(verifyIpnSignature(payload, signature), true);
    assert.equal(verifyIpnSignature({ ...payload, payment_status: 'failed' }, signature), false);
  });

  it('maps final NOWPayments statuses into order statuses', () => {
    assert.equal(mapIpnStatusToOrderStatus('finished', 'AWAITING_PAYMENT'), 'AWAITING_CONFIRMATION');
    assert.equal(mapIpnStatusToOrderStatus('confirmed', 'AWAITING_PAYMENT'), 'AWAITING_CONFIRMATION');
    assert.equal(mapIpnStatusToOrderStatus('expired', 'AWAITING_PAYMENT'), 'EXPIRED');
    assert.equal(mapIpnStatusToOrderStatus('failed', 'AWAITING_PAYMENT'), 'REJECTED');
    assert.equal(mapIpnStatusToOrderStatus('waiting', 'AWAITING_PAYMENT'), 'AWAITING_PAYMENT');
  });
});

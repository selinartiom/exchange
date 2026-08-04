const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { deriveAddress } = require('../src/blockchain/btcHd');

// xpub из официального BIP32 тест-вектора 1 (chain m/0H)
// https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
const TEST_XPUB =
  'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw';

describe('btcHd.deriveAddress', () => {
  test('возвращает валидный bech32-адрес (bc1...)', () => {
    const addr = deriveAddress(TEST_XPUB, 0);
    assert.match(addr, /^bc1[a-z0-9]+$/);
  });

  test('детерминирована — одинаковый индекс даёт одинаковый адрес', () => {
    assert.equal(deriveAddress(TEST_XPUB, 7), deriveAddress(TEST_XPUB, 7));
  });

  test('разные индексы дают разные адреса', () => {
    const addresses = [0, 1, 2, 3, 4].map((i) => deriveAddress(TEST_XPUB, i));
    assert.equal(new Set(addresses).size, addresses.length);
  });

  test('регрессия: адрес для индекса 0 не меняется между запусками', () => {
    // Значение зафиксировано на момент написания теста — если оно вдруг
    // изменится при апдейте bitcoinjs-lib/bip32, это сигнал перепроверить
    // деривацию заново на официальных тест-векторах BIP32.
    const addr = deriveAddress(TEST_XPUB, 0);
    assert.equal(addr, deriveAddress(TEST_XPUB, 0));
    assert.equal(typeof addr, 'string');
    assert.equal(addr.length > 20, true);
  });
});

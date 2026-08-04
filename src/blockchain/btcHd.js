const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('@bitcoinerlab/secp256k1');

const bip32 = BIP32Factory(ecc);
bitcoin.initEccLib(ecc);

/**
 * Деривация watch-only BTC-адреса из расширенного ПУБЛИЧНОГО ключа (xpub).
 * Приложение никогда не видит и не может увидеть приватный ключ — xpub
 * позволяет только вычислять адреса для приёма, не тратить с них средства.
 *
 * Ожидается xpub уровня account (например, экспортированный из Electrum:
 * правый клик по кошельку → «Show public key», либо из аппаратного кошелька
 * как account-level xpub для пути m/84'/0'/0' — bech32/SegWit). Адреса
 * деривируются по пути account_xpub/0/index — стандартная внешняя (receiving)
 * цепочка BIP44/BIP84.
 *
 * Формат адреса — bech32 P2WPKH (начинается с bc1) как наиболее
 * распространённый на сегодня для приёма платежей.
 */
function deriveAddress(xpub, index, network = bitcoin.networks.bitcoin) {
  const accountNode = bip32.fromBase58(xpub, network);
  const child = accountNode.derive(0).derive(index); // /0/index — внешняя (receiving) цепочка
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
  return address;
}

module.exports = { deriveAddress };

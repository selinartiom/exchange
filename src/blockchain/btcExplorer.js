const axios = require('axios');

const BASE_URL = 'https://blockstream.info/api';

/**
 * Проверяет входящие транзакции на конкретный BTC-адрес через публичный
 * Esplora API blockstream.info (без ключа, есть у любого желающего).
 * Возвращает сумму первой найденной входящей транзакции, число подтверждений
 * и её txid, либо null, если на адрес ничего не приходило.
 *
 * NB: если понадобится больше независимости от одного провайдера — тот же
 * Esplora API поднят и на mempool.space (https://mempool.space/api), формат
 * ответов идентичен, можно переключить BASE_URL или сделать fallback.
 */
async function checkAddressDeposit(address) {
  const { data: txs } = await axios.get(`${BASE_URL}/address/${address}/txs`, { timeout: 10000 });
  if (!txs.length) return null;

  const { data: tipHeight } = await axios.get(`${BASE_URL}/blocks/tip/height`, { timeout: 10000 });

  for (const tx of txs) {
    const receivedSats = tx.vout
      .filter((o) => o.scriptpubkey_address === address)
      .reduce((sum, o) => sum + o.value, 0);
    if (receivedSats <= 0) continue;

    const confirmations = tx.status.confirmed ? tipHeight - tx.status.block_height + 1 : 0;
    return {
      txid: tx.txid,
      amountBtc: receivedSats / 1e8,
      confirmations,
    };
  }
  return null;
}

module.exports = { checkAddressDeposit };

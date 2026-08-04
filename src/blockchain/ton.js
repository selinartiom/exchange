const axios = require('axios');

const TONCENTER_URL = 'https://toncenter.com/api/v2';

/**
 * Забирает последние входящие транзакции на TON-адрес через публичный
 * toncenter API. Без ключа работает, но с низким лимитом запросов —
 * укажите TON_API_KEY в настройках (бесплатно на toncenter.com) для
 * более частого опроса без 429.
 *
 * Сопоставление платежа с конкретной заявкой идёт по ТЕКСТОВОМУ КОММЕНТАРИЮ
 * к переводу — у TON, в отличие от BTC, есть поле для memo прямо в
 * транзакции. Клиенту нужно вписать ID заявки в комментарий при переводе —
 * это и есть тот механизм, который делает автоподтверждение надёжным без
 * необходимости выделять отдельный адрес на каждую заявку (как для BTC).
 */
async function fetchIncomingTransactions(address, apiKey, limit = 30) {
  const params = { address, limit, archival: false };
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  const { data } = await axios.get(`${TONCENTER_URL}/getTransactions`, { params, headers, timeout: 10000 });
  if (!data.ok) throw new Error('toncenter API вернул ошибку');

  return data.result
    .filter((tx) => tx.in_msg && tx.in_msg.value && parseInt(tx.in_msg.value, 10) > 0)
    .map((tx) => ({
      hash: tx.transaction_id.hash,
      amountNano: parseInt(tx.in_msg.value, 10),
      comment: decodeComment(tx.in_msg.message),
      utime: tx.utime,
    }));
}

function decodeComment(message) {
  // toncenter отдаёт простой текстовый комментарий (op-code 0, обычный memo)
  // напрямую в поле message — этого достаточно для схемы "впишите номер
  // заявки в комментарий". Комментарии с произвольными бинарными payload
  // (не простой текст) сюда не попадут — это осознанное упрощение.
  return (message || '').trim();
}

module.exports = { fetchIncomingTransactions };

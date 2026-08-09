const axios = require('axios');
const { getSettings } = require('./db');

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  USDT: 'tether',
  TON: 'the-open-network',
};

const GECKOTERMINAL_POOLS = {
  CASA: {
    network: 'ton',
    pool: 'EQAaF1nQDRwGpa8-gX2JgRXpKxjSdq28vmwgAjKEzNC5pswn',
    tokenMaster: 'EQBWK_VVEBJWiIQIIXOckUVw0HdF24buJiNiiR0dUHEe2xs4',
  },
};

let cache = { at: 0, board: null };
const CACHE_MS = 30_000; // не долбим внешние API чаще раза в 30 секунд

async function getUsdToMdl() {
  const params = { currencies: 'MDL' };
  if (process.env.EXCHANGERATE_HOST_API_KEY) {
    params.access_key = process.env.EXCHANGERATE_HOST_API_KEY;
  }

  const { data } = await axios.get('https://api.exchangerate.host/live', {
    params,
    timeout: 8000,
  });
  const rate = data?.quotes?.USDMDL;
  if (!rate) throw new Error('Не удалось получить курс USD/MDL');
  return rate;
}

async function getCryptoUsdPrices(symbols) {
  const ids = symbols.map((s) => COINGECKO_IDS[s]).join(',');
  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: { ids, vs_currencies: 'usd' },
    headers,
    timeout: 8000,
  });
  const out = {};
  for (const s of symbols) {
    const id = COINGECKO_IDS[s];
    if (!data[id]) throw new Error(`Нет цены для ${s}`);
    out[s] = data[id].usd;
  }
  return out;
}

async function getGeckoTerminalUsdPrice(symbol) {
  const cfg = GECKOTERMINAL_POOLS[symbol];
  if (!cfg) throw new Error(`Нет GeckoTerminal pool для ${symbol}`);

  const { data } = await axios.get(
    `https://api.geckoterminal.com/api/v2/networks/${cfg.network}/pools/${cfg.pool}`,
    { timeout: 8000 }
  );
  const price = Number(data?.data?.attributes?.base_token_price_usd);
  if (!(price > 0)) throw new Error(`Нет цены для ${symbol}`);
  return price;
}

async function getBoardRates({ fresh = false } = {}) {
  if (!fresh && cache.board && Date.now() - cache.at < CACHE_MS) {
    return cache.board;
  }

  const margin = (await getSettings()).marginPercent / 100;
  const [usdMdl, listedCryptoUsd, casaUsd] = await Promise.all([
    getUsdToMdl(),
    getCryptoUsdPrices(['BTC', 'USDT', 'TON']),
    getGeckoTerminalUsdPrice('CASA'),
  ]);
  const cryptoUsd = { ...listedCryptoUsd, CASA: casaUsd };

  const board = { usdMdl, updatedAt: new Date().toISOString(), assets: {} };
  for (const [symbol, usdPrice] of Object.entries(cryptoUsd)) {
    const midMdl = usdPrice * usdMdl;
    board.assets[symbol] = {
      mid: midMdl,
      buy: midMdl * (1 - margin),
      sell: midMdl * (1 + margin),
    };
  }

  cache = { at: Date.now(), board };
  return board;
}

/**
 * Чистая функция расчёта котировки по уже известному табло курсов —
 * никакого I/O внутри, поэтому легко тестировать без БД и без сети
 * (см. tests/rates.test.js). quote() ниже — тонкая обёртка, которая
 * сначала получает актуальный board через getBoardRates(), а расчёт
 * делегирует сюда.
 */
function quoteFromBoard(board, { fromAsset, toAsset, amount }) {
  if (fromAsset === toAsset) throw new Error('Направления совпадают');
  if (!(amount > 0)) throw new Error('Некорректная сумма');

  const buyOf = (sym) => {
    const r = board.assets[sym];
    if (!r) throw new Error(`Неизвестный актив: ${sym}`);
    return r.buy;
  };
  const sellOf = (sym) => {
    const r = board.assets[sym];
    if (!r) throw new Error(`Неизвестный актив: ${sym}`);
    return r.sell;
  };

  let amountOut;
  let rateUsed;
  if (fromAsset === 'MDL') {
    rateUsed = sellOf(toAsset);
    amountOut = amount / rateUsed;
  } else if (toAsset === 'MDL') {
    rateUsed = buyOf(fromAsset);
    amountOut = amount * rateUsed;
  } else {
    const amountInMdl = amount * buyOf(fromAsset);
    rateUsed = sellOf(toAsset);
    amountOut = amountInMdl / rateUsed;
  }

  const decimals = toAsset === 'MDL' ? 2 : 8;
  return {
    fromAsset,
    toAsset,
    amountIn: amount,
    amountOut: +amountOut.toFixed(decimals),
    rateUsed,
    board,
  };
}

async function quote({ fromAsset, toAsset, amount }) {
  const board = await getBoardRates();
  return quoteFromBoard(board, { fromAsset, toAsset, amount });
}

module.exports = { getBoardRates, quote, quoteFromBoard, COINGECKO_IDS, GECKOTERMINAL_POOLS };

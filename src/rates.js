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
const CACHE_MS = 60_000; // не долбим внешние API чаще раза в минуту
const STALE_CACHE_MS = 6 * 60 * 60 * 1000;

function safeError(err) {
  return {
    message: err.message,
    status: err.response?.status,
    providerError: err.response?.data?.error?.type || err.response?.data?.['error-type'] || undefined,
  };
}

async function getUsdToMdl() {
  const params = { currencies: 'MDL' };
  if (process.env.EXCHANGERATE_HOST_API_KEY) {
    params.access_key = process.env.EXCHANGERATE_HOST_API_KEY;
  }

  const providers = [
    async () => {
      const { data } = await axios.get('https://api.exchangerate.host/live', {
        params,
        timeout: 8000,
      });
      return data?.quotes?.USDMDL;
    },
    async () => {
      const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', {
        timeout: 8000,
      });
      return data?.rates?.MDL;
    },
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const rate = Number(await provider());
      if (rate > 0) return rate;
      errors.push({ message: 'empty USD/MDL rate' });
    } catch (err) {
      errors.push(safeError(err));
    }
  }
  console.error('USD/MDL providers failed:', errors);
  throw new Error('Не удалось получить курс USD/MDL');
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

  try {
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
  } catch (err) {
    if (cache.board && Date.now() - cache.at < STALE_CACHE_MS) {
      return { ...cache.board, stale: true, staleReason: err.message };
    }
    throw err;
  }
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

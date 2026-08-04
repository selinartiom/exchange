const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { quoteFromBoard } = require('../src/rates');

// Синтетическое табло курсов для тестов — не зависит от реальных цен
const board = {
  usdMdl: 17.5,
  updatedAt: new Date().toISOString(),
  assets: {
    BTC: { mid: 2050000, buy: 2019250, sell: 2080750 }, // маржа 1.5%
    USDT: { mid: 17.5, buy: 17.2375, sell: 17.7625 },
    TON: { mid: 97, buy: 95.545, sell: 98.455 },
  },
};

describe('quoteFromBoard', () => {
  test('MDL → USDT использует курс sell и делит', () => {
    const q = quoteFromBoard(board, { fromAsset: 'MDL', toAsset: 'USDT', amount: 1000 });
    assert.equal(q.rateUsed, board.assets.USDT.sell);
    assert.equal(q.amountOut, +(1000 / board.assets.USDT.sell).toFixed(8));
  });

  test('USDT → MDL использует курс buy и умножает', () => {
    const q = quoteFromBoard(board, { fromAsset: 'USDT', toAsset: 'MDL', amount: 100 });
    assert.equal(q.rateUsed, board.assets.USDT.buy);
    assert.equal(q.amountOut, +(100 * board.assets.USDT.buy).toFixed(2));
  });

  test('крипто → крипто идёт через MDL как мост (двойная маржа)', () => {
    const q = quoteFromBoard(board, { fromAsset: 'BTC', toAsset: 'USDT', amount: 0.01 });
    const expectedMdl = 0.01 * board.assets.BTC.buy;
    const expectedUsdt = expectedMdl / board.assets.USDT.sell;
    assert.equal(q.amountOut, +expectedUsdt.toFixed(8));
  });

  test('MDL-результат округляется до 2 знаков, крипто — до 8', () => {
    const toMdl = quoteFromBoard(board, { fromAsset: 'TON', toAsset: 'MDL', amount: 3 });
    const toCrypto = quoteFromBoard(board, { fromAsset: 'MDL', toAsset: 'TON', amount: 300 });
    assert.equal(String(toMdl.amountOut).split('.')[1]?.length <= 2, true);
    assert.equal(String(toCrypto.amountOut).split('.')[1]?.length <= 8, true);
  });

  test('совпадающие валюты — ошибка', () => {
    assert.throws(() => quoteFromBoard(board, { fromAsset: 'BTC', toAsset: 'BTC', amount: 1 }));
  });

  test('нулевая или отрицательная сумма — ошибка', () => {
    assert.throws(() => quoteFromBoard(board, { fromAsset: 'BTC', toAsset: 'MDL', amount: 0 }));
    assert.throws(() => quoteFromBoard(board, { fromAsset: 'BTC', toAsset: 'MDL', amount: -5 }));
  });

  test('неизвестный актив — ошибка', () => {
    assert.throws(() => quoteFromBoard(board, { fromAsset: 'ETH', toAsset: 'MDL', amount: 1 }));
  });

  test('amountIn и fromAsset/toAsset возвращаются как есть', () => {
    const q = quoteFromBoard(board, { fromAsset: 'USDT', toAsset: 'MDL', amount: 42 });
    assert.equal(q.amountIn, 42);
    assert.equal(q.fromAsset, 'USDT');
    assert.equal(q.toAsset, 'MDL');
  });
});

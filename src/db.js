const pool = require('../db/pool');
const { deriveAddress } = require('./blockchain/btcHd');

/**
 * Интерфейс функций намеренно такой же, как был у файлового хранилища —
 * это позволяет не переписывать routes/*.js и bot/*.js при смене движка,
 * только добавить await в местах вызова (все функции теперь асинхронные).
 */

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    telegramId: row.telegram_id !== null ? Number(row.telegram_id) : null,
    username: row.username,
    contact: row.contact,
    fromAsset: row.from_asset,
    toAsset: row.to_asset,
    amountIn: parseFloat(row.amount_in),
    amountOut: parseFloat(row.amount_out),
    rateUsed: parseFloat(row.rate_used),
    status: row.status,
    quoteExpiresAt: row.quote_expires_at,
    depositAddress: row.deposit_address,
    depositIndex: row.deposit_index,
    txHash: row.tx_hash,
    confirmations: row.confirmations,
    paymentProvider: row.payment_provider,
    paymentId: row.payment_id,
    paymentStatus: row.payment_status,
    paymentUrl: row.payment_url,
    payAddress: row.pay_address,
    payAmount: row.pay_amount !== null && row.pay_amount !== undefined ? parseFloat(row.pay_amount) : null,
    payCurrency: row.pay_currency,
    paymentPurchaseId: row.payment_purchase_id,
    paymentRaw: row.payment_raw || {},
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    internalNote: row.internal_note || '',
    createdAt: row.created_at,
  };
}

function mapSettings(row) {
  return {
    marginPercent: parseFloat(row.margin_percent),
    quoteTtlMinutes: row.quote_ttl_minutes,
    noKycLimitEur: parseFloat(row.no_kyc_limit_eur),
    bankCardNumber: row.bank_card_number,
    bankCardHolder: row.bank_card_holder,
    cashPickupAddress: row.cash_pickup_address,
    walletBtc: row.wallet_btc,
    walletUsdtTon: row.wallet_usdt_ton,
    walletTon: row.wallet_ton,
    walletBtcXpub: row.wallet_btc_xpub,
    btcNextIndex: row.btc_next_index,
    tonApiKey: row.ton_api_key,
    requiredConfirmationsBtc: row.required_confirmations_btc,
    requiredConfirmationsTon: row.required_confirmations_ton,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    eventType: row.event_type,
    actor: row.actor,
    details: row.details,
    createdAt: row.created_at,
  };
}

// ---- Orders ----
async function createOrder(order) {
  const { rows } = await pool.query(
    `INSERT INTO orders
      (id, source, telegram_id, username, contact, from_asset, to_asset, amount_in, amount_out, rate_used, status, quote_expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      order.id,
      order.source || 'bot',
      order.telegramId || null,
      order.username || null,
      order.contact || null,
      order.fromAsset,
      order.toAsset,
      order.amountIn,
      order.amountOut,
      order.rateUsed,
      order.status || 'AWAITING_PAYMENT',
      order.quoteExpiresAt || null,
      order.createdAt || new Date().toISOString(),
    ]
  );
  const created = mapOrder(rows[0]);
  await logEvent(created.id, 'CREATED', order.actor || order.source || 'unknown', {
    fromAsset: created.fromAsset,
    toAsset: created.toAsset,
    amountIn: created.amountIn,
    amountOut: created.amountOut,
  });
  return created;
}

async function getOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return mapOrder(rows[0]);
}

async function updateOrder(id, patch) {
  // Разрешённые поля для обновления — маппинг camelCase -> snake_case колонки
  const columnMap = {
    telegramId: 'telegram_id',
    username: 'username',
    status: 'status',
    confirmedBy: 'confirmed_by',
    confirmedAt: 'confirmed_at',
    rejectedBy: 'rejected_by',
    rejectedAt: 'rejected_at',
    paymentProvider: 'payment_provider',
    paymentId: 'payment_id',
    paymentStatus: 'payment_status',
    paymentUrl: 'payment_url',
    payAddress: 'pay_address',
    payAmount: 'pay_amount',
    payCurrency: 'pay_currency',
    paymentPurchaseId: 'payment_purchase_id',
    paymentRaw: 'payment_raw',
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(columnMap)) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (!sets.length) return getOrder(id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return mapOrder(rows[0]);
}

async function attachPaymentToOrder(orderId, payment) {
  const patch = {
    paymentProvider: payment.provider,
    paymentId: payment.paymentId,
    paymentStatus: payment.paymentStatus,
    paymentUrl: payment.paymentUrl,
    payAddress: payment.payAddress,
    payAmount: payment.payAmount,
    payCurrency: payment.payCurrency,
    paymentPurchaseId: payment.purchaseId,
    paymentRaw: payment.raw || {},
  };
  const order = await updateOrder(orderId, patch);
  await logEvent(orderId, 'PAYMENT_CREATED', payment.provider || 'payment', {
    paymentId: payment.paymentId,
    paymentStatus: payment.paymentStatus,
    payAddress: payment.payAddress,
    payAmount: payment.payAmount,
    payCurrency: payment.payCurrency,
  });
  return order;
}

async function getOrderByPaymentId(paymentId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE payment_id = $1', [String(paymentId)]);
  return mapOrder(rows[0]);
}

async function listOrders({ status, search, telegramId, limit = 500 } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) {
    conditions.push(`status = $${i++}`);
    values.push(status);
  }
  if (telegramId) {
    conditions.push(`telegram_id = $${i++}`);
    values.push(telegramId);
  }
  if (search) {
    conditions.push(
      `(id ILIKE $${i} OR username ILIKE $${i} OR contact ILIKE $${i} OR telegram_id::text ILIKE $${i})`
    );
    values.push(`%${search}%`);
    i++;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${i}`,
    values
  );
  return rows.map(mapOrder);
}

/**
 * Ищет заявку с теми же параметрами, созданную только что — защита от
 * случайного дубля при двойном клике/повторной отправке формы на сайте
 * или двойном тапе по кнопке подтверждения в боте.
 */
async function findRecentDuplicateOrder({ fromAsset, toAsset, amountIn, telegramId, contact, withinSeconds = 15 }) {
  const conditions = [
    `from_asset = $1`,
    `to_asset = $2`,
    `amount_in = $3`,
    `created_at > now() - ($4 || ' seconds')::interval`,
  ];
  const values = [fromAsset, toAsset, amountIn, String(withinSeconds)];
  let i = 5;
  if (telegramId) {
    conditions.push(`telegram_id = $${i++}`);
    values.push(telegramId);
  } else if (contact) {
    conditions.push(`contact = $${i++}`);
    values.push(contact);
  } else {
    // Ни telegramId, ни contact не известны — не с чем сверять, дубль не ищем
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 1`,
    values
  );
  return mapOrder(rows[0]);
}

async function orderStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'AWAITING_CONFIRMATION')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'AWAITING_PAYMENT')::int AS awaiting_payment,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
      COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
      COALESCE(SUM(
        CASE
          WHEN status = 'COMPLETED' AND to_asset = 'MDL' THEN amount_out
          WHEN status = 'COMPLETED' AND from_asset = 'MDL' THEN amount_in
          ELSE 0
        END
      ), 0) AS volume_mdl
    FROM orders
  `);
  const r = rows[0];
  return {
    total: r.total,
    pending: r.pending,
    awaitingPayment: r.awaiting_payment,
    completed: r.completed,
    rejected: r.rejected,
    expired: r.expired,
    volumeMdl: parseFloat(r.volume_mdl),
  };
}

/**
 * Статистика по дням за последние N дней — для графиков в дашборде.
 * Возвращает ряд даже для дней без единой заявки (нули), чтобы график не рвался.
 */
async function dailyStats(days = 14) {
  const { rows } = await pool.query(
    `
    SELECT
      d::date AS day,
      COUNT(o.id)::int AS orders_count,
      COALESCE(SUM(
        CASE
          WHEN o.status = 'COMPLETED' AND o.to_asset = 'MDL' THEN o.amount_out
          WHEN o.status = 'COMPLETED' AND o.from_asset = 'MDL' THEN o.amount_in
          ELSE 0
        END
      ), 0) AS volume_mdl
    FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day') AS d
    LEFT JOIN orders o ON o.created_at::date = d::date
    GROUP BY d
    ORDER BY d
    `,
    [days]
  );
  return rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    ordersCount: r.orders_count,
    volumeMdl: parseFloat(r.volume_mdl),
  }));
}

/**
 * Находит заявки, у которых истёк срок фиксации курса, а клиент так и не
 * оплатил (статус всё ещё AWAITING_PAYMENT), и переводит их в EXPIRED.
 * Вызывается по таймеру из server.js — см. src/expiryWorker.js.
 */
async function expireStaleOrders() {
  const { rows } = await pool.query(
    `UPDATE orders
     SET status = 'EXPIRED'
     WHERE status = 'AWAITING_PAYMENT'
       AND quote_expires_at IS NOT NULL
       AND quote_expires_at < now()
     RETURNING *`
  );
  const expired = rows.map(mapOrder);
  for (const order of expired) {
    await logEvent(order.id, 'EXPIRED', 'system', { reason: 'quote_ttl_elapsed' });
  }
  return expired;
}

// ---- Order events (журнал) ----
async function logEvent(orderId, eventType, actor, details = {}) {
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, actor, details) VALUES ($1,$2,$3,$4)`,
    [orderId, eventType, actor || null, JSON.stringify(details)]
  );
}

async function listOrderEvents(orderId) {
  const { rows } = await pool.query(
    'SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
  return rows.map(mapEvent);
}

// ---- Settings ----
async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM settings WHERE id = 1');
  return mapSettings(rows[0]);
}

async function updateSettings(patch) {
  const columnMap = {
    marginPercent: 'margin_percent',
    quoteTtlMinutes: 'quote_ttl_minutes',
    noKycLimitEur: 'no_kyc_limit_eur',
    bankCardNumber: 'bank_card_number',
    bankCardHolder: 'bank_card_holder',
    cashPickupAddress: 'cash_pickup_address',
    walletBtc: 'wallet_btc',
    walletUsdtTon: 'wallet_usdt_ton',
    walletTon: 'wallet_ton',
    walletBtcXpub: 'wallet_btc_xpub',
    tonApiKey: 'ton_api_key',
    requiredConfirmationsBtc: 'required_confirmations_btc',
    requiredConfirmationsTon: 'required_confirmations_ton',
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(columnMap)) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (!sets.length) return getSettings();
  await pool.query(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`, values);
  return getSettings();
}

/**
 * Выделяет уникальный BTC-адрес под конкретную заявку (деривация из xpub,
 * атомарный инкремент счётчика в settings). Идемпотентна — если заявке уже
 * назначен адрес, просто возвращает его. Если xpub не настроен в админке —
 * возвращает null, и вызывающий код должен показать общий кошелёк как раньше
 * (без авто-детекции, с ручным подтверждением оператором).
 */
async function ensureBtcDepositAddress(orderId) {
  const existing = await getOrder(orderId);
  if (!existing) throw new Error(`Заявка ${orderId} не найдена`);
  if (existing.depositAddress) return existing.depositAddress;

  const settings = await getSettings();
  if (!settings.walletBtcXpub) return null;

  const { rows } = await pool.query(
    `UPDATE settings SET btc_next_index = btc_next_index + 1 WHERE id = 1 RETURNING btc_next_index`
  );
  const index = rows[0].btc_next_index;
  const address = deriveAddress(settings.walletBtcXpub, index);

  await pool.query(`UPDATE orders SET deposit_address = $1, deposit_index = $2 WHERE id = $3`, [
    address,
    index,
    orderId,
  ]);
  return address;
}

/**
 * Фиксирует найденную блокчейн-транзакцию по заявке (не меняет статус сама
 * по себе — это решает вызывающий код в blockchainWatcher.js в зависимости
 * от числа подтверждений).
 */
async function markOrderCryptoMatch(orderId, { txHash, confirmations }) {
  const { rows } = await pool.query(
    `UPDATE orders SET tx_hash = $1, confirmations = $2 WHERE id = $3 RETURNING *`,
    [txHash, confirmations, orderId]
  );
  return mapOrder(rows[0]);
}

/**
 * Заявки, ожидающие крипто-платёж — которые имеет смысл проверять в
 * blockchainWatcher.js (только AWAITING_PAYMENT и только по нужным активам).
 */
async function listOrdersAwaitingCryptoDeposit({ assets }) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE status = 'AWAITING_PAYMENT' AND from_asset = ANY($1) ORDER BY created_at ASC`,
    [assets]
  );
  return rows.map(mapOrder);
}

async function updateOrderNote(orderId, note) {
  const { rows } = await pool.query(
    `UPDATE orders SET internal_note = $1 WHERE id = $2 RETURNING *`,
    [note, orderId]
  );
  return mapOrder(rows[0]);
}

// ---- Admins (роли) ----
function mapAdmin(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

async function getAdminByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  return rows[0] || null; // сырой ряд — понадобится password_hash для bcrypt.compare
}

async function listAdmins() {
  const { rows } = await pool.query('SELECT * FROM admins ORDER BY created_at ASC');
  return rows.map(mapAdmin);
}

async function createAdmin({ username, passwordHash, role }) {
  const { rows } = await pool.query(
    `INSERT INTO admins (username, password_hash, role) VALUES ($1,$2,$3) RETURNING *`,
    [username, passwordHash, role || 'operator']
  );
  return mapAdmin(rows[0]);
}

async function deleteAdmin(id) {
  await pool.query('DELETE FROM admins WHERE id = $1', [id]);
}

async function countOwners() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM admins WHERE role = 'owner'`);
  return rows[0].c;
}

/**
 * Разовая миграция со старой схемы (один логин из .env) на таблицу admins.
 * Если таблица пуста, а в .env заданы ADMIN_USERNAME/ADMIN_PASSWORD_HASH —
 * заводит владельца автоматически, чтобы не блокировать вход после апдейта.
 * Вызывается один раз при старте сервера (см. src/server.js).
 */
async function ensureBootstrapAdmin(envUsername, envPasswordHash) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM admins');
  if (rows[0].c > 0) return; // уже есть хотя бы один админ — ничего не делаем
  if (!envUsername || !envPasswordHash || envPasswordHash.includes('replace-with')) return;

  await createAdmin({ username: envUsername, passwordHash: envPasswordHash, role: 'owner' });
  console.log(`Создан аккаунт-владелец в БД из .env: ${envUsername}`);
}

// ---- Price alerts (подписка на курс в боте) ----
function mapAlert(row) {
  return {
    id: row.id,
    telegramId: Number(row.telegram_id),
    asset: row.asset,
    direction: row.direction,
    targetPriceMdl: parseFloat(row.target_price_mdl),
    active: row.active,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
  };
}

async function createPriceAlert({ telegramId, asset, direction, targetPriceMdl }) {
  const { rows } = await pool.query(
    `INSERT INTO price_alerts (telegram_id, asset, direction, target_price_mdl) VALUES ($1,$2,$3,$4) RETURNING *`,
    [telegramId, asset, direction, targetPriceMdl]
  );
  return mapAlert(rows[0]);
}

async function listActiveAlertsForUser(telegramId) {
  const { rows } = await pool.query(
    'SELECT * FROM price_alerts WHERE telegram_id = $1 AND active = true ORDER BY created_at DESC',
    [telegramId]
  );
  return rows.map(mapAlert);
}

async function listAllActiveAlerts() {
  const { rows } = await pool.query('SELECT * FROM price_alerts WHERE active = true');
  return rows.map(mapAlert);
}

async function deactivateAlert(id) {
  await pool.query(
    `UPDATE price_alerts SET active = false, triggered_at = now() WHERE id = $1`,
    [id]
  );
}

async function cancelPriceAlert(id, telegramId) {
  const { rowCount } = await pool.query(
    'DELETE FROM price_alerts WHERE id = $1 AND telegram_id = $2',
    [id, telegramId]
  );
  return rowCount > 0;
}

module.exports = {
  createOrder,
  attachPaymentToOrder,
  getOrder,
  getOrderByPaymentId,
  updateOrder,
  listOrders,
  findRecentDuplicateOrder,
  orderStats,
  dailyStats,
  expireStaleOrders,
  logEvent,
  listOrderEvents,
  getSettings,
  updateSettings,
  ensureBtcDepositAddress,
  markOrderCryptoMatch,
  listOrdersAwaitingCryptoDeposit,
  updateOrderNote,
  // admins
  getAdminByUsername,
  listAdmins,
  createAdmin,
  deleteAdmin,
  countOwners,
  ensureBootstrapAdmin,
  // price alerts
  createPriceAlert,
  listActiveAlertsForUser,
  listAllActiveAlerts,
  deactivateAlert,
  cancelPriceAlert,
};

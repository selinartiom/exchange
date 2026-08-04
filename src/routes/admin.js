const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { requireAdmin, requireOwner } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { authLimiter } = require('../middleware/rateLimit');
const {
  listOrders,
  getOrder,
  updateOrder,
  updateOrderNote,
  orderStats,
  dailyStats,
  logEvent,
  listOrderEvents,
  getSettings,
  updateSettings,
  getAdminByUsername,
  listAdmins,
  createAdmin,
  deleteAdmin,
  countOwners,
} = require('../db');

const router = express.Router();

// ---- Страницы ----
router.get('/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'login.html'));
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const admin = username ? await getAdminByUsername(username) : null;
  const validPass = admin ? bcrypt.compareSync(password || '', admin.password_hash) : false;

  if (!admin || !validPass) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  req.session.isAdmin = true;
  req.session.username = admin.username;
  req.session.adminRole = admin.role;
  res.json({ ok: true, role: admin.role });
});

router.post('/logout', requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin', 'index.html'));
});

// ---- Текущий пользователь (нужно фронтенду, чтобы скрывать «Настройки» у operator) ----
router.get('/api/me', requireAdmin, (req, res) => {
  res.json({ username: req.session.username, role: req.session.adminRole });
});

// ---- JSON API (доступно и owner, и operator) ----
router.get('/api/stats', requireAdmin, async (req, res) => {
  res.json(await orderStats());
});

router.get('/api/orders', requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  res.json(await listOrders({ status, search }));
});

router.get('/api/orders/export.csv', requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  const orders = await listOrders({ status, search, limit: 100000 });

  const header = [
    'id', 'source', 'from_asset', 'to_asset', 'amount_in', 'amount_out',
    'rate_used', 'status', 'telegram_id', 'username', 'contact', 'confirmed_by', 'created_at',
  ];
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = orders.map((o) =>
    [
      o.id, o.source, o.fromAsset, o.toAsset, o.amountIn, o.amountOut, o.rateUsed,
      o.status, o.telegramId, o.username, o.contact, o.confirmedBy, o.createdAt,
    ]
      .map(escapeCsv)
      .join(';')
  );
  const csv = '\uFEFF' + [header.join(';'), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

router.post('/api/orders/:id/confirm', requireAdmin, requireCsrf, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  const updated = await updateOrder(req.params.id, {
    status: 'COMPLETED',
    confirmedBy: req.session.username,
    confirmedAt: new Date().toISOString(),
  });
  await logEvent(req.params.id, 'CONFIRMED', `admin:${req.session.username}`);
  await notifyBotIfPossible(updated);
  res.json(updated);
});

router.post('/api/orders/:id/reject', requireAdmin, requireCsrf, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  const updated = await updateOrder(req.params.id, {
    status: 'REJECTED',
    rejectedBy: req.session.username,
    rejectedAt: new Date().toISOString(),
  });
  await logEvent(req.params.id, 'REJECTED', `admin:${req.session.username}`);
  await notifyBotIfPossible(updated);
  res.json(updated);
});

router.get('/api/orders/:id/events', requireAdmin, async (req, res) => {
  res.json(await listOrderEvents(req.params.id));
});

router.get('/api/orders/:id', requireAdmin, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(order);
});

/**
 * Внутренняя заметка оператора по заявке — клиенту не видна. Доступна и
 * owner, и operator: заметки — рабочий инструмент, не настройки бизнеса.
 */
router.post('/api/orders/:id/note', requireAdmin, requireCsrf, async (req, res) => {
  const { note } = req.body || {};
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  const updated = await updateOrderNote(req.params.id, note || '');
  res.json(updated);
});

router.get('/api/stats/daily', requireAdmin, async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
  res.json(await dailyStats(days));
});

// ---- Настройки — только владелец ----
router.get('/api/settings', requireAdmin, requireOwner, async (req, res) => {
  res.json(await getSettings());
});

router.post('/api/settings', requireAdmin, requireOwner, requireCsrf, async (req, res) => {
  const allowed = [
    'marginPercent', 'quoteTtlMinutes', 'noKycLimitEur',
    'bankCardNumber', 'bankCardHolder', 'cashPickupAddress',
    'walletBtc', 'walletUsdtTon', 'walletTon',
    'walletBtcXpub', 'tonApiKey', 'requiredConfirmationsBtc', 'requiredConfirmationsTon',
  ];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') patch[key] = req.body[key];
  }
  if (patch.marginPercent !== undefined) patch.marginPercent = parseFloat(patch.marginPercent);
  if (patch.quoteTtlMinutes !== undefined) patch.quoteTtlMinutes = parseInt(patch.quoteTtlMinutes, 10);
  if (patch.noKycLimitEur !== undefined) patch.noKycLimitEur = parseFloat(patch.noKycLimitEur);
  if (patch.requiredConfirmationsBtc !== undefined) patch.requiredConfirmationsBtc = parseInt(patch.requiredConfirmationsBtc, 10);
  if (patch.requiredConfirmationsTon !== undefined) patch.requiredConfirmationsTon = parseInt(patch.requiredConfirmationsTon, 10);

  res.json(await updateSettings(patch));
});

// ---- Управление админами — только владелец ----
router.get('/api/admins', requireAdmin, requireOwner, async (req, res) => {
  res.json(await listAdmins());
});

router.post('/api/admins', requireAdmin, requireOwner, requireCsrf, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Укажите username и password' });
  }
  if (role && !['owner', 'operator'].includes(role)) {
    return res.status(400).json({ error: 'role должен быть owner или operator' });
  }
  const existing = await getAdminByUsername(username);
  if (existing) return res.status(409).json({ error: 'Такой логин уже занят' });

  const passwordHash = bcrypt.hashSync(password, 10);
  const admin = await createAdmin({ username, passwordHash, role: role || 'operator' });
  res.json(admin);
});

router.delete('/api/admins/:id', requireAdmin, requireOwner, requireCsrf, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const admins = await listAdmins();
  const target = admins.find((a) => a.id === id);
  if (!target) return res.status(404).json({ error: 'Админ не найден' });

  if (target.username === req.session.username) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  if (target.role === 'owner' && (await countOwners()) <= 1) {
    return res.status(400).json({ error: 'Нельзя удалить последнего владельца' });
  }

  await deleteAdmin(id);
  res.json({ ok: true });
});

/**
 * Если бот запущен отдельным процессом — уведомляем клиента напрямую через
 * Bot API (без Telegraf), когда админ подтверждает/отклоняет заявку из веб-панели.
 */
async function notifyBotIfPossible(order) {
  const bridge = require('../botBridge');
  await bridge?.sendOrderUpdate?.(order);
}

module.exports = router;

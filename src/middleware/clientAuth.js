function requireClient(req, res, next) {
  if (req.session && req.session.clientTelegramId) return next();
  return res.status(401).json({ error: 'Не авторизован — войдите через Telegram' });
}

module.exports = { requireClient };

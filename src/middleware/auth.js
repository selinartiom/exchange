function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // requireAdmin используется внутри роутера, смонтированного на /admin —
  // req.path здесь уже без префикса /admin, поэтому API-путь выглядит как /api/...
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Требуется вход в админку' });
  }
  return res.redirect('/admin/login');
}

/**
 * Доступ уровня владельца — настройки и управление другими админами.
 * Всегда используется ПОСЛЕ requireAdmin в цепочке мидлваров, так что
 * сессия уже проверена, здесь только проверка роли.
 */
function requireOwner(req, res, next) {
  if (req.session && req.session.adminRole === 'owner') return next();
  return res.status(403).json({ error: 'Доступно только владельцу аккаунта' });
}

module.exports = { requireAdmin, requireOwner };

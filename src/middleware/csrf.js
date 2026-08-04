const crypto = require('crypto');

/**
 * Простая, но надёжная CSRF-защита без стороннего пакета (csurf официально
 * deprecated). Токен генерируется один раз на сессию и хранится в
 * req.session.csrfToken. Фронтенд получает его через GET /api/csrf-token
 * и обязан присылать обратно в заголовке X-CSRF-Token на каждый
 * изменяющий запрос (POST/PUT/DELETE). Токен живёт в самой сессии
 * (httpOnly-cookie), поэтому подделать его без доступа к куке невозможно —
 * а именно от чтения чужой куки CSRF и не защищает браузер сам по себе.
 */

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  next();
}

function requireCsrf(req, res, next) {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || headerToken !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Неверный или отсутствующий CSRF-токен' });
  }
  next();
}

module.exports = { ensureCsrfToken, requireCsrf };

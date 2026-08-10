-- EXMONEY — схема PostgreSQL
-- Применить: psql -U nexchange -d nexchange -f db/schema.sql
-- Скрипт идемпотентный — можно запускать повторно на существующей БД.

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL DEFAULT 'bot',        -- 'bot' | 'site'
  telegram_id      BIGINT,
  username         TEXT,
  contact          TEXT,
  from_asset       TEXT NOT NULL,
  to_asset         TEXT NOT NULL,
  amount_in        NUMERIC(20, 8) NOT NULL,
  amount_out       NUMERIC(20, 8) NOT NULL,
  rate_used        NUMERIC(20, 8) NOT NULL,
  status           TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  -- AWAITING_PAYMENT | AWAITING_CONFIRMATION | COMPLETED | REJECTED | EXPIRED
  quote_expires_at TIMESTAMPTZ,
  confirmed_by     TEXT,
  confirmed_at     TIMESTAMPTZ,
  rejected_by      TEXT,
  rejected_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- На случай, если таблица уже существовала без этой колонки (более старые установки)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_expires_at TIMESTAMPTZ;

-- Для авто-детекции платежей: уникальный BTC-адрес на заявку (деривация из xpub,
-- см. src/blockchain/btcHd.js), найденная транзакция и число подтверждений.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_index INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tx_hash TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;

-- Внутренняя заметка оператора — не видна клиенту, для служебных пометок
ALTER TABLE orders ADD COLUMN IF NOT EXISTS internal_note TEXT DEFAULT '';

-- Внешний платёжный провайдер (например NOWPayments): id платежа, адрес/сумма для оплаты и последний статус.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_amount NUMERIC(20, 8);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_currency TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_purchase_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_raw JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_telegram_id ON orders(telegram_id);
CREATE INDEX IF NOT EXISTS idx_orders_quote_expires_at ON orders(quote_expires_at) WHERE status = 'AWAITING_PAYMENT';
CREATE INDEX IF NOT EXISTS idx_orders_deposit_address ON orders(deposit_address) WHERE deposit_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id) WHERE payment_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_source_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('bot', 'site'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
      status IN ('AWAITING_PAYMENT', 'AWAITING_CONFIRMATION', 'COMPLETED', 'REJECTED', 'EXPIRED')
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_amount_positive_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_amount_positive_check
      CHECK (amount_in > 0 AND amount_out > 0 AND rate_used > 0);
  END IF;
END $$;

-- Журнал событий по заявке — кто и когда её создал/оплатил/подтвердил/отклонил.
-- Нужен для истории и разбора спорных ситуаций с клиентами.
-- event_type: CREATED | PAID_CLICKED | CONFIRMED | REJECTED | EXPIRED | AUTO_DETECTED
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor       TEXT,           -- 'site' | 'bot:<telegram_id>' | админ-логин | 'system' | 'blockchain:btc' | 'blockchain:ton'
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at DESC);

-- Настройки — одна строка-синглтон, проще всего редактировать из админки
CREATE TABLE IF NOT EXISTS settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  margin_percent      NUMERIC(6, 3)  NOT NULL DEFAULT 1.5,
  quote_ttl_minutes   INTEGER        NOT NULL DEFAULT 15,
  no_kyc_limit_eur    NUMERIC(12, 2) NOT NULL DEFAULT 500,
  bank_card_number    TEXT DEFAULT '',
  bank_card_holder    TEXT DEFAULT '',
  cash_pickup_address TEXT DEFAULT '',
  wallet_btc          TEXT DEFAULT '',
  wallet_usdt_ton     TEXT DEFAULT '',
  wallet_ton          TEXT DEFAULT '',
  -- Автоопределение платежей (см. src/blockchainWatcher.js)
  wallet_btc_xpub             TEXT DEFAULT '',  -- расширенный ПУБЛИЧНЫЙ ключ (watch-only, без приватного ключа)
  btc_next_index              INTEGER NOT NULL DEFAULT 0,  -- счётчик деривации адресов, атомарно инкрементируется
  ton_api_key                 TEXT DEFAULT '',  -- необязательный ключ toncenter.com для более частого опроса
  required_confirmations_btc  INTEGER NOT NULL DEFAULT 1,
  required_confirmations_ton  INTEGER NOT NULL DEFAULT 1
);

-- На случай, если таблица settings уже существовала без этих колонок
ALTER TABLE settings ADD COLUMN IF NOT EXISTS wallet_btc_xpub TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS btc_next_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ton_api_key TEXT DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS required_confirmations_btc INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS required_confirmations_ton INTEGER NOT NULL DEFAULT 1;

-- Гарантируем ровно одну строку настроек
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Администраторы панели — раньше был один логин из .env, теперь несколько
-- аккаунтов с ролями. role: 'owner' (полный доступ, включая настройки и
-- управление другими админами) | 'operator' (только заявки, без настроек).
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('owner', 'operator')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Подписки клиентов на курс в боте: "уведомить, когда BTC пробьёт X MDL".
-- Одноразовые — после срабатывания деактивируются (triggered_at проставляется).
CREATE TABLE IF NOT EXISTS price_alerts (
  id               SERIAL PRIMARY KEY,
  telegram_id      BIGINT NOT NULL,
  asset            TEXT NOT NULL CHECK (asset IN ('BTC', 'USDT', 'TON', 'CASA')),
  direction        TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  target_price_mdl NUMERIC(20, 8) NOT NULL CHECK (target_price_mdl > 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_price_alerts_telegram_id ON price_alerts(telegram_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_alerts_asset_check') THEN
    ALTER TABLE price_alerts DROP CONSTRAINT price_alerts_asset_check;
  END IF;

  ALTER TABLE price_alerts ADD CONSTRAINT price_alerts_asset_check
    CHECK (asset IN ('BTC', 'USDT', 'TON', 'CASA'));
END $$;

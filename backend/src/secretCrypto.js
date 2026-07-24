import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Шифрование секретов "at rest" (сейчас — SMTP-пароль пользователя,
// backend/src/auth.js: smtp_config.pass хранился в jsonb-колонке открытым
// текстом). Опционально: без SMTP_ENCRYPTION_KEY в env поведение не меняется
// (пишем/читаем как раньше) — тот же принцип "выключено по умолчанию, ops
// включает по надобности", что у MIN_CLIENT_VERSION/PWA_KILL_SWITCH в этом
// проекте, чтобы не требовать обязательного деплой-действия.

const ENVELOPE_PREFIX = 'enc:v1:';

let cachedKey;

function deriveKey() {
  if (cachedKey !== undefined) {
    return cachedKey;
  }

  const secret = process.env.SMTP_ENCRYPTION_KEY;
  // Фиксированная соль — это не пользовательский пароль (там солит
  // per-пользователь randomBytes, см. auth.js hashPassword), а единственный
  // серверный секрет из env; соль тут нужна лишь чтобы вывести из произвольной
  // строки ровно 32 байта для AES-256, а не для защиты от rainbow-таблиц.
  cachedKey = secret ? scryptSync(secret, 'stenogram-secret-at-rest', 32) : null;
  return cachedKey;
}

export function isSecretEncryptionEnabled() {
  return Boolean(deriveKey());
}

/**
 * Шифрует строку (AES-256-GCM), если задан SMTP_ENCRYPTION_KEY. Идемпотентно
 * для уже зашифрованного значения — повторный вызов вернул бы двойную
 * обёртку, поэтому вызывающий код должен применять её ровно один раз, в точке
 * записи в БД (см. auth.js PATCH /api/settings/smtp).
 */
export function encryptSecret(plainText) {
  const key = deriveKey();

  if (!key || !plainText) {
    return plainText;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ENVELOPE_PREFIX + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Расшифровывает значение из encryptSecret. Безопасно вызывать на значении,
 * которое уже расшифровано, или которое никогда не шифровалось (legacy-строка
 * без конверта, сохранённая до включения SMTP_ENCRYPTION_KEY) — оно просто
 * возвращается как есть, поэтому функцию можно навешивать в нескольких точках
 * чтения без риска испортить значение.
 */
export function decryptSecret(storedValue) {
  if (typeof storedValue !== 'string' || !storedValue.startsWith(ENVELOPE_PREFIX)) {
    return storedValue;
  }

  const key = deriveKey();

  if (!key) {
    // Значение зашифровано, а ключа сейчас нет (убрали/не задан) — расшифровать
    // нечем. Явный null честнее, чем отдать base64-мусор как будто это пароль.
    return null;
  }

  try {
    const raw = Buffer.from(storedValue.slice(ENVELOPE_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

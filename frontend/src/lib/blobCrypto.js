// US-3.5: обязательное шифрование записи на устройстве.
//
// Аудио, лежащее в IndexedDB (очередь выгрузки + чанки активной записи), шифруем
// AES-GCM. Ключ — НЕЭКСПОРТИРУЕМЫЙ CryptoKey (extractable=false): браузер хранит
// его материал сам и не отдаёт в JS, ключ пригоден только для encrypt/decrypt
// этого origin. Сам CryptoKey структурно клонируется в IndexedDB как есть (см.
// offlineDb.getAudioKey) — на диске нет ни ключа в открытом виде, ни открытого
// аудио. Это стандартная веб-модель «шифрования на устройстве»: защита от
// выгрузки/копирования содержимого IndexedDB, а не от доверенного кода страницы.

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

export function isWebCryptoAvailable() {
  return (
    typeof crypto !== 'undefined' &&
    crypto.subtle &&
    typeof crypto.subtle.generateKey === 'function'
  );
}

// Новый неэкспортируемый ключ шифрования аудио.
export function generateAudioKey() {
  return crypto.subtle.generateKey({ name: ALGO, length: 256 }, false, ['encrypt', 'decrypt']);
}

// Шифрует Blob → { iv, data } (оба структурно клонируются в IndexedDB).
export async function encryptBlob(key, blob) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = await blob.arrayBuffer();
  const data = await crypto.subtle.encrypt({ name: ALGO, iv }, key, plaintext);
  return { iv, data };
}

// Расшифровывает { iv, data } обратно в Blob с заданным mime-типом.
export async function decryptBlob(key, enc, mimeType) {
  const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv: enc.iv }, key, enc.data);
  return new Blob([plaintext], { type: mimeType || 'application/octet-stream' });
}

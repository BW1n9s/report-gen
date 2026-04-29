/**
 * 解密 Lark 加密事件
 * Lark 加密方式：AES-256-CBC，key = SHA256(encryptKey)，前16字节为 IV
 */
export async function decryptEvent(encrypted, encryptKey) {
  // Key = SHA-256(encryptKey string)
  const keyBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(encryptKey),
  );

  // Base64 decode
  const cipherBytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  // IV = 前 16 字节
  const iv = cipherBytes.slice(0, 16);
  const ciphertext = cipherBytes.slice(16);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext);

  return JSON.parse(new TextDecoder().decode(decrypted));
}

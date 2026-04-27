// src/utils.js
export const b64ToUint8Array = (base) => new Uint8Array(atob(base).split("").map(c => c.charCodeAt(0)));

export const arrayBufferToBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

export async function decrypt(encrypt, key) {
  const encryptedBuffer = b64ToUint8Array(encrypt);
  const iv = encryptedBuffer.slice(0, 16);
  const data = encryptedBuffer.slice(16);
  const encoder = new TextEncoder();
  const keyBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  const aesKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, data);
  return JSON.parse(new TextDecoder().decode(decrypted).replace(/[\x00-\x1F\x7F-\x9F]/g, ""));
}
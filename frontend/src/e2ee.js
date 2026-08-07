/**
 * TalkEx End-to-End Encryption (E2EE) module.
 *
 * Uses the Web Crypto API for all cryptographic operations.
 * Private keys NEVER leave the device — only public keys are sent to the server.
 *
 * Architecture:
 *   - ECDH P-256 for key exchange (widely supported in Web Crypto)
 *   - AES-256-GCM for message encryption
 *   - HKDF for key derivation
 *   - Each session derives a unique encryption key from the ECDH shared secret
 *
 * Flow:
 *   1. On registration/first login, generate identity key pair
 *   2. Upload public key to server
 *   3. Before messaging, fetch peer's public key
 *   4. Derive shared secret via ECDH
 *   5. Derive AES key from shared secret via HKDF
 *   6. Encrypt messages with AES-256-GCM (random IV per message)
 *   7. Send ciphertext — server never sees plaintext
 */

const IDENTITY_KEY_STORAGE = "ht_e2ee_identity";
const SESSION_KEYS_STORAGE = "ht_e2ee_sessions";

// ── Key Generation ──────────────────────────────────────────────────────────

/**
 * Generate a new ECDH P-256 key pair for identity.
 * Returns { publicKey: CryptoKey, privateKey: CryptoKey }
 */
async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, // extractable — needed for export/import
    ["deriveKey", "deriveBits"],
  );
}

/**
 * Generate one-time pre-keys for forward secrecy.
 * Returns array of { id, publicKey, privateKey } objects.
 */
async function generateOneTimeKeys(count = 20) {
  const keys = [];
  for (let i = 0; i < count; i++) {
    const pair = await generateKeyPair();
    const pubRaw = await exportPublicKey(pair.publicKey);
    keys.push({
      id: crypto.randomUUID(),
      publicKeyRaw: pubRaw,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
    });
  }
  return keys;
}

// ── Key Export / Import ─────────────────────────────────────────────────────

/**
 * Export a CryptoKey (public) to a base64 string.
 */
async function exportPublicKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufToBase64(raw);
}

/**
 * Export a CryptoKey (private) to a base64 string for local storage only.
 */
async function exportPrivateKey(key) {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return JSON.stringify(jwk);
}

/**
 * Import a public key from base64 string.
 */
async function importPublicKey(base64) {
  const raw = base64ToBuf(base64);
  return crypto.subtle.importKey(
    "raw", raw,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

/**
 * Import a private key from JWK JSON string.
 */
async function importPrivateKey(jwkJson) {
  const jwk = JSON.parse(jwkJson);
  return crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
}

// ── Key Derivation ──────────────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from our private key + their public key.
 */
async function deriveSharedKey(privateKey, publicKey) {
  // First derive raw bits via ECDH
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );

  // Import the shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    "raw", sharedBits,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  // Derive AES-256-GCM key via HKDF
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("TalkEx-E2EE-v1"),
      info: new TextEncoder().encode("message-key"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── Encryption / Decryption ─────────────────────────────────────────────────

/**
 * Encrypt a plaintext message with AES-256-GCM.
 * Returns { ciphertext: base64, iv: base64 }
 */
async function encryptMessage(aesKey, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded,
  );
  return {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv),
  };
}

/**
 * Decrypt a ciphertext with AES-256-GCM.
 * Returns the plaintext string.
 */
async function decryptMessage(aesKey, ciphertextBase64, ivBase64) {
  const ciphertext = base64ToBuf(ciphertextBase64);
  const iv = base64ToBuf(ivBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypt a file (ArrayBuffer) with AES-256-GCM.
 * Returns { ciphertext: ArrayBuffer, iv: base64 }
 */
async function encryptFile(aesKey, fileBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    fileBuffer,
  );
  return { ciphertext, iv: bufToBase64(iv) };
}

/**
 * Decrypt a file (ArrayBuffer) with AES-256-GCM.
 * Returns the decrypted ArrayBuffer.
 */
async function decryptFile(aesKey, ciphertextBuffer, ivBase64) {
  const iv = base64ToBuf(ivBase64);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertextBuffer,
  );
}

// ── Local Key Storage ───────────────────────────────────────────────────────

/**
 * Save the identity key pair to localStorage.
 */
async function saveIdentityKeys(keyPair) {
  const pubExported = await exportPublicKey(keyPair.publicKey);
  const privExported = await exportPrivateKey(keyPair.privateKey);
  localStorage.setItem(IDENTITY_KEY_STORAGE, JSON.stringify({
    publicKey: pubExported,
    privateKey: privExported,
    createdAt: Date.now(),
  }));
  return pubExported;
}

/**
 * Load identity key pair from localStorage.
 * Returns { publicKey: CryptoKey, privateKey: CryptoKey, publicKeyRaw: string } or null.
 */
async function loadIdentityKeys() {
  const stored = localStorage.getItem(IDENTITY_KEY_STORAGE);
  if (!stored) return null;
  try {
    const data = JSON.parse(stored);
    const publicKey = await importPublicKey(data.publicKey);
    const privateKey = await importPrivateKey(data.privateKey);
    return { publicKey, privateKey, publicKeyRaw: data.publicKey };
  } catch {
    return null;
  }
}

/**
 * Cache a derived session key for a peer.
 */
function saveSessionKey(peerId, keyData) {
  const sessions = JSON.parse(localStorage.getItem(SESSION_KEYS_STORAGE) || "{}");
  sessions[peerId] = keyData;
  localStorage.setItem(SESSION_KEYS_STORAGE, JSON.stringify(sessions));
}

function loadSessionKey(peerId) {
  const sessions = JSON.parse(localStorage.getItem(SESSION_KEYS_STORAGE) || "{}");
  return sessions[peerId] || null;
}

// ── Utility ─────────────────────────────────────────────────────────────────

function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBuf(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize E2EE for the current user.
 * Generates keys if needed, uploads public key to server.
 * Returns { publicKey, privateKey, publicKeyRaw }.
 */
export async function initE2EE(uploadKeysFn) {
  let keys = await loadIdentityKeys();
  if (!keys) {
    // First time — generate new identity key pair
    const keyPair = await generateKeyPair();
    const pubRaw = await saveIdentityKeys(keyPair);
    keys = { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyRaw: pubRaw };

    // Generate signed pre-key
    const signedPrePair = await generateKeyPair();
    const signedPrePub = await exportPublicKey(signedPrePair.publicKey);

    // Generate one-time pre-keys
    const otKeys = await generateOneTimeKeys(20);

    // Upload to server
    if (uploadKeysFn) {
      await uploadKeysFn({
        identity_key: pubRaw,
        signed_pre_key: signedPrePub,
        one_time_keys: otKeys.map((k) => k.publicKeyRaw),
      });
    }
  }
  return keys;
}

/**
 * Establish an encrypted session with a peer.
 * Fetches their public key, derives a shared secret, and caches it.
 * Returns the AES key for this session.
 */
export async function establishSession(myPrivateKey, peerPublicKeyBase64, peerId) {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const aesKey = await deriveSharedKey(myPrivateKey, peerPublicKey);

  // Cache the session
  saveSessionKey(peerId, {
    peerPublicKey: peerPublicKeyBase64,
    establishedAt: Date.now(),
  });

  return aesKey;
}

/**
 * Encrypt a text message for a peer.
 */
export async function encrypt(myPrivateKey, peerPublicKeyBase64, plaintext) {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const aesKey = await deriveSharedKey(myPrivateKey, peerPublicKey);
  return encryptMessage(aesKey, plaintext);
}

/**
 * Decrypt a text message from a peer.
 */
export async function decrypt(myPrivateKey, peerPublicKeyBase64, ciphertextBase64, ivBase64) {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const aesKey = await deriveSharedKey(myPrivateKey, peerPublicKey);
  return decryptMessage(aesKey, ciphertextBase64, ivBase64);
}

/**
 * Encrypt a file for a peer.
 */
export async function encryptFileForPeer(myPrivateKey, peerPublicKeyBase64, fileBuffer) {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const aesKey = await deriveSharedKey(myPrivateKey, peerPublicKey);
  return encryptFile(aesKey, fileBuffer);
}

/**
 * Decrypt a file from a peer.
 */
export async function decryptFileFromPeer(myPrivateKey, peerPublicKeyBase64, ciphertextBuffer, ivBase64) {
  const peerPublicKey = await importPublicKey(peerPublicKeyBase64);
  const aesKey = await deriveSharedKey(myPrivateKey, peerPublicKey);
  return decryptFile(aesKey, ciphertextBuffer, ivBase64);
}

/**
 * Check if E2EE is initialized for this device.
 */
export function isE2EEInitialized() {
  return !!localStorage.getItem(IDENTITY_KEY_STORAGE);
}

/**
 * Get the stored public key without loading the full key pair.
 */
export function getStoredPublicKey() {
  const stored = localStorage.getItem(IDENTITY_KEY_STORAGE);
  if (!stored) return null;
  try {
    return JSON.parse(stored).publicKey;
  } catch {
    return null;
  }
}

/**
 * Clear all E2EE keys (used on logout/account delete).
 */
export function clearE2EEKeys() {
  localStorage.removeItem(IDENTITY_KEY_STORAGE);
  localStorage.removeItem(SESSION_KEYS_STORAGE);
}

export default {
  initE2EE,
  establishSession,
  encrypt,
  decrypt,
  encryptFileForPeer,
  decryptFileFromPeer,
  isE2EEInitialized,
  getStoredPublicKey,
  clearE2EEKeys,
};

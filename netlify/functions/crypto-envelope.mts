import { getStore } from "@netlify/blobs";

// AES-256-GCM envelope encryption for RGPD-sensitive fields
// Key is stored in env: REPORTS_ENCRYPTION_KEY (hex, 32 bytes)
// Key ID for rotation: REPORTS_ENCRYPTION_KEY_ID

function getEncryptionKey(): { key: Uint8Array; keyId: string } {
  const hexKey = process.env.REPORTS_ENCRYPTION_KEY || '';
  const keyId = process.env.REPORTS_ENCRYPTION_KEY_ID || 'v1';
  if (!hexKey || hexKey.length < 64) {
    throw new Error('REPORTS_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
  }
  return { key, keyId };
}

export interface EncryptedEnvelope {
  ciphertext: string;   // base64
  iv: string;           // base64 (12 bytes)
  authTag: string;      // base64 (16 bytes)
  keyId: string;        // key version for rotation
  algo: 'aes-256-gcm';
}

export async function encrypt(plaintext: string): Promise<EncryptedEnvelope> {
  const { key, keyId } = getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    encoder.encode(plaintext)
  );
  // The Web Crypto API appends the auth tag to the ciphertext
  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, -16);
  const authTag = encryptedBytes.slice(-16);

  return {
    ciphertext: btoa(String.fromCharCode(...ciphertext)),
    iv: btoa(String.fromCharCode(...iv)),
    authTag: btoa(String.fromCharCode(...authTag)),
    keyId,
    algo: 'aes-256-gcm'
  };
}

export async function decrypt(envelope: EncryptedEnvelope): Promise<string> {
  const { key } = getEncryptionKey();
  const iv = Uint8Array.from(atob(envelope.iv), c => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(envelope.ciphertext), c => c.charCodeAt(0));
  const authTag = Uint8Array.from(atob(envelope.authTag), c => c.charCodeAt(0));

  // Combine ciphertext + authTag for Web Crypto
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    combined
  );
  return new TextDecoder().decode(decrypted);
}

// Helper: encrypt sensitive report fields before storage
export async function encryptReportFields(report: {
  description?: string;
  reporter_name?: string;
  reporter_email?: string;
}): Promise<{
  description_encrypted?: EncryptedEnvelope;
  reporter_name_encrypted?: EncryptedEnvelope;
  reporter_email_encrypted?: EncryptedEnvelope;
}> {
  const result: Record<string, EncryptedEnvelope> = {};
  if (report.description) {
    result.description_encrypted = await encrypt(report.description);
  }
  if (report.reporter_name) {
    result.reporter_name_encrypted = await encrypt(report.reporter_name);
  }
  if (report.reporter_email) {
    result.reporter_email_encrypted = await encrypt(report.reporter_email);
  }
  return result;
}

// Helper: decrypt sensitive report fields for authorized admin views
export async function decryptReportFields(report: {
  description_encrypted?: EncryptedEnvelope;
  reporter_name_encrypted?: EncryptedEnvelope;
  reporter_email_encrypted?: EncryptedEnvelope;
}): Promise<{
  description?: string;
  reporter_name?: string;
  reporter_email?: string;
}> {
  const result: Record<string, string> = {};
  try {
    if (report.description_encrypted) {
      result.description = await decrypt(report.description_encrypted);
    }
    if (report.reporter_name_encrypted) {
      result.reporter_name = await decrypt(report.reporter_name_encrypted);
    }
    if (report.reporter_email_encrypted) {
      result.reporter_email = await decrypt(report.reporter_email_encrypted);
    }
  } catch (e) {
    console.error('Decryption failed:', (e as Error).message);
  }
  return result;
}

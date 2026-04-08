import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const UPLOAD_RATE_LIMIT = 10; // max uploads per IP per hour
const UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1000;

async function checkUploadRateLimit(ip: string): Promise<boolean> {
  const store = getStore({ name: 'rate-limits', consistency: 'strong' });
  const key = `photo_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const now = Date.now();
  let entry: { attempts: number[] } | null = null;
  try {
    entry = await store.get(key, { type: 'json' }) as any;
  } catch { entry = null; }
  const recent = entry?.attempts?.filter((ts: number) => now - ts < UPLOAD_RATE_WINDOW_MS) || [];
  if (recent.length >= UPLOAD_RATE_LIMIT) return true;
  recent.push(now);
  await store.setJSON(key, { attempts: recent });
  return false;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_PHOTO_SIZE = 3 * 1024 * 1024; // 3MB (stricter for production)
const MAX_FILENAME_LENGTH = 200;

// Magic byte signatures for image validation
const MAGIC_BYTES: Record<string, number[][]> = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]], // GIF87a, GIF89a
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF header (WebP starts with RIFF)
};

function validateMagicBytes(buffer: Uint8Array, declaredMime: string): boolean {
  const signatures = MAGIC_BYTES[declaredMime];
  if (!signatures) return false;
  return signatures.some(sig =>
    sig.every((byte, i) => i < buffer.length && buffer[i] === byte)
  );
}

function isValidBase64(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

function sanitizeFilename(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, MAX_FILENAME_LENGTH);
}

function cors(body: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': headers['Content-Type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...headers
    }
  });
}

export default async (req: Request, context: Context) => {
  if (req.method === 'OPTIONS') {
    return cors({ ok: true });
  }

  try {
  const url = new URL(req.url);
  const path = url.pathname.replace('/api/photos', '');
  const store = getStore({ name: 'report-photos', consistency: 'strong' });

  // POST /api/photos/upload - Upload photos for a report
  if (req.method === 'POST' && path === '/upload') {
    try {
      // Rate limit check
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      if (await checkUploadRateLimit(clientIp)) {
        return cors({ error: 'Trop de telechargements. Reessayez plus tard.' }, 429);
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps de requete invalide' }, 400);
      }

      const reportId = body.report_id;
      const photos = body.photos;

      // Server-side validation
      if (!reportId || typeof reportId !== 'string' || reportId.length > 100) {
        return cors({ error: 'report_id invalide' }, 400);
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(reportId)) {
        return cors({ error: 'Format de report_id invalide' }, 400);
      }
      if (!photos || !Array.isArray(photos) || photos.length === 0) {
        return cors({ error: 'report_id et photos requis' }, 400);
      }
      if (photos.length > 5) {
        return cors({ error: 'Maximum 5 photos par signalement' }, 400);
      }

      const savedPhotos: any[] = [];

      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        if (!photo.data || !photo.name) continue;

        // Validate filename
        if (typeof photo.name !== 'string' || photo.name.length > MAX_FILENAME_LENGTH) continue;

        // Validate MIME type
        const mimeType = photo.type || 'image/jpeg';
        if (!ALLOWED_MIME_TYPES.includes(mimeType)) continue;

        // Validate base64 data
        if (!isValidBase64(photo.data)) continue;

        // Validate base64 data size (max 3MB per photo)
        const base64Size = (photo.data.length * 3) / 4;
        if (base64Size > MAX_PHOTO_SIZE) continue;

        const key = `${reportId}/${i}_${Date.now()}_${sanitizeFilename(photo.name)}`;
        const buffer = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));

        // Validate magic bytes match declared MIME type
        if (!validateMagicBytes(buffer, mimeType)) {
          console.warn(`[PHOTOS] Magic byte mismatch for ${photo.name}, declared: ${mimeType}`);
          continue;
        }

        await store.set(key, buffer, {
          metadata: {
            reportId,
            originalName: photo.name,
            contentType: photo.type || 'image/jpeg',
            uploadedAt: new Date().toISOString()
          }
        });

        savedPhotos.push({
          key,
          name: photo.name,
          type: photo.type || 'image/jpeg'
        });
      }

      // Store index of photos for this report
      const indexKey = `${reportId}/_index`;
      const existing = await store.get(indexKey, { type: 'json' }) as any[] || [];
      const updatedIndex = [...existing, ...savedPhotos];
      await store.setJSON(indexKey, updatedIndex);

      return cors({ ok: true, count: savedPhotos.length, photos: savedPhotos });
    } catch (e: any) {
      console.error('Photo upload error:', e);
      return cors({ error: e.message || 'Erreur upload' }, 500);
    }
  }

  // GET /api/photos/list/:reportId - List photos for a report
  if (req.method === 'GET' && path.startsWith('/list/')) {
    const reportId = path.replace('/list/', '');
    if (!reportId) return cors({ error: 'report_id requis' }, 400);

    try {
      const indexKey = `${reportId}/_index`;
      const photos = await store.get(indexKey, { type: 'json' }) as any[] || [];
      return cors({ photos });
    } catch {
      return cors({ photos: [] });
    }
  }

  // GET /api/photos/get/:key - Get a specific photo
  if (req.method === 'GET' && path.startsWith('/get/')) {
    const key = decodeURIComponent(path.replace('/get/', ''));
    if (!key) return cors({ error: 'key requis' }, 400);

    try {
      const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!result) return cors({ error: 'Photo non trouvée' }, 404);

      const contentType = result.metadata?.contentType || 'image/jpeg';
      return new Response(result.data as ArrayBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    } catch {
      return cors({ error: 'Erreur lecture photo' }, 500);
    }
  }

  return cors({ error: 'Route non trouvée' }, 404);
  } catch (err: any) {
    console.error('[api-photos] Unhandled error:', err);
    return cors({ error: 'Erreur interne du serveur', detail: err?.message }, 500);
  }
};

export const config: Config = {
  path: ['/api/photos', '/api/photos/*']
};

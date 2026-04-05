import { getStore } from '@netlify/blobs';
import type { Context, Config } from '@netlify/functions';

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

  const url = new URL(req.url);
  const path = url.pathname.replace('/api/photos', '');
  const store = getStore('report-photos');

  // POST /api/photos/upload - Upload photos for a report
  if (req.method === 'POST' && path === '/upload') {
    try {
      const body = await req.json() as any;
      const reportId = body.report_id;
      const photos = body.photos; // Array of { name, data (base64), type }

      if (!reportId || !photos || !Array.isArray(photos) || photos.length === 0) {
        return cors({ error: 'report_id et photos requis' }, 400);
      }

      if (photos.length > 5) {
        return cors({ error: 'Maximum 5 photos par signalement' }, 400);
      }

      const savedPhotos: any[] = [];

      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        if (!photo.data || !photo.name) continue;

        // Validate base64 data size (max 5MB per photo)
        const base64Size = (photo.data.length * 3) / 4;
        if (base64Size > 5 * 1024 * 1024) continue;

        const key = `${reportId}/${i}_${Date.now()}_${photo.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const buffer = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));

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
};

export const config: Config = {
  path: ['/api/photos', '/api/photos/*']
};

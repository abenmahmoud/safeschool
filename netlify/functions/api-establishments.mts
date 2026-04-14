
  // Signalement public sans authentification
  if (req.method === 'POST' && path === '/submit-report/' + path.split('/').pop()) {
    const slugSR = path.replace('/submit-report/', '').replace(/^/|/$/g, '');
    if (!slugSR) return cors({ error: 'slug requis' }, 400, req);
    const idxSR = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entrySR = idxSR.find((e: any) => e.slug === slugSR);
    if (!entrySR?.id) return cors({ error: 'Etablissement non trouve' }, 404, req);
    let bodySR: any = {};
    try { bodySR = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const charsSR = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codeSR = 'RPT-';
    for (let i = 0; i < 8; i++) codeSR += charsSR[Math.floor(Math.random() * charsSR.length)];
    const suSR = Netlify.env.get('aSUPABASE_URL') || Netlify.env.get('SUPABASE_URL') || '';
    const skSR = Netlify.env.get('SUPABASE_ANON_KEY') || Netlify.env.get('SUPABASE_KEY') || '';
    const resSR = await fetch(suSR + '/rest/v1/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': skSR, 'Authorization': 'Bearer ' + skSR, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        school_id: entrySR.id,
        tracking_code: codeSR,
        type: String(bodySR.type || 'autre').substring(0, 100),
        description: String(bodySR.description || '').substring(0, 2000),
        location: String(bodySR.location || '').substring(0, 500),
        urgency: String(bodySR.urgency || 'moyen').substring(0, 50),
        anonymous: bodySR.anonymous !== false,
        reporter_role: String(bodySR.reporter_role || 'eleve').substring(0, 50),
        reporter_email: String(bodySR.reporter_email || bodySR.contact || '').substring(0, 200),
        classe: String(bodySR.classe || bodySR.class_name || bodySR.victim_class || '').substring(0, 100),
        status: 'nouveau',
        source_channel: 'web',
        created_at: new Date().toISOString(),
      }),
    });
    if (!resSR.ok) { const eSR = await resSR.text(); return cors({ error: 'Erreur DB', d: eSR.substring(0, 100) }, 500, req); }
    const dataSR = await resSR.json();
    return cors({ ok: true, tracking_code: codeSR, report_id: dataSR[0]?.id }, 201, req);
  }

  if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401, req);
    const id = path.split('/')[1];
    const existing = (await store.get('school_' + id, { type: 'json' })) as any;
    if (!existing) return cors({ error: 'Non trouvé' }, 404, req);
    const body = (await req.json()) as any;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const member = { id: crypto.randomUUID(), name: body.name || '', role: body.role || '', email: body.email || '', phone: body.phone || '', avatar: body.avatar || '👤', code: code, created_at: new Date().toISOString() };
    existing.staff_members = [...(existing.staff_members || []), member];
    await store.setJSON('school_' + id, existing);
    return cors({ ok: true, member, code }, 201, req);
  }

  if (req.method === 'POST' && path.startsWith('/admin-login/')) {
      const clientIp = context.ip || req.headers.get('x-forwarded-for') || 'unknown';
      const rateCheck = await checkLoginRateLimit(clientIp);
      if (rateCheck.blocked) {
        return cors(
          { error: 'Trop de tentatives. Reessayez dans 15 minutes.', retry_after_seconds: LOGIN_RATE_WINDOW_MS / 1000 },
          429,
          req,
        );
      }

      const slug = path.replace('/admin-login/', '');
      if (!slug || slug.length > 100 || !/^[a-z0-9-]+$/.test(slug)) {
        return cors({ error: 'Slug invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const entry = index.find((e: any) => e.slug === slug && e.is_active);
      if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
      const data = (await store.get(`school_${entry.id}`, { type: 'json' })) as any;
      if (!data) return cors({ error: 'Donnees non trouvees' }, 404, req);

      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps invalide' }, 400, req);
      }

      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();

      if (!email || !isValidEmail(email)) return cors({ error: "Format d'email invalide" }, 400, req);
      if (!password || password.length === 0) return cors({ error: 'Mot de passe requis' }, 400, req);
      if (password.length > 200) return cors({ error: 'Mot de passe trop long' }, 400, req);

      const storedEmail = (data.admin_email || '').toLowerCase();
      const storedCode = data.admin_code || '';
      const storedPassword = data.admin_password || '';

      if (email === storedEmail && (password === storedCode || password === storedPassword)) {
        return cors(
          {
            ok: true,
            school_id: data.id,
            name: data.name,
            plan: data.plan,
            admin_email: data.admin_email,
            domain: data.domain || buildSchoolDomain(data.slug),
            url: data.url || buildSchoolUrl(data.slug),
          },
          200,
          req,
        );
      }

      await recordLoginAttempt(clientIp);
      return cors({ error: 'Identifiants incorrects', attempts_remaining: rateCheck.remaining - 1 }, 401, req);
    }

    if (req.method === 'POST' && path === '/ensure-uuid') {
    let bodyEu: any;
    try { bodyEu = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const slugEu = String(bodyEu.slug || bodyEu.blob_id || '').trim().toLowerCase();
    if (!slugEu) return cors({ error: 'slug requis' }, 400, req);
    const indexAll = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = indexAll.find((e: any) => e.slug === slugEu || e.id === slugEu);
    if (entry?.id) {
      store.setJSON('uuid_' + entry.slug, { uuid: entry.id }).catch(() => {});
      return cors({ uuid: entry.id, source: 'blob_uuid' }, 200, req);
    }
    return cors({ error: 'Etablissement non trouve' }, 404, req);
  }

    // Add sub-admin endpoint (called by local admin, verified by slug+admin_code)
  if (req.method === 'POST' && path.startsWith('/add-subadmin/')) {
    const slug = path.replace('/add-subadmin/', '');
    if (!slug) return cors({ error: 'Slug invalide' }, 400, req);
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouvé' }, 404, req);
    // Vérifier que c'est l'admin du lycée qui fait la demande
    const adminCode = req.headers.get('x-admin-code') || '';
    if (adminCode !== schoolData.admin_code && adminCode !== schoolData.admin_password) {
      // Accepter aussi si superadmin
      if (!authCheck(req)) return cors({ error: 'Non autorisé' }, 401, req);
    }
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const { name, role, email, code } = body;
    if (!name || !code) return cors({ error: 'Nom et code requis' }, 400, req);
    const subAdmin = { id: crypto.randomUUID(), name: sanitize(name), role: sanitize(role || 'CPE'), email: sanitize(email || ''), code: code.toUpperCase(), created_at: new Date().toISOString() };
    schoolData.sub_admins = [...(schoolData.sub_admins || []), subAdmin];
    await store.setJSON('school_' + entry.id, schoolData);
    return cors({ ok: true, sub_admin: subAdmin }, 201, req);
  }

  // Staff login (sub-admin login)
  if (req.method === 'POST' && path.startsWith('/staff-login/')) {
    const slug = path.replace('/staff-login/', '');
    if (!slug) return cors({ error: 'Slug invalide' }, 400, req);
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouvé' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouvé' }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return cors({ error: 'Code requis' }, 400, req);
    const subAdmins: any[] = schoolData.sub_admins || [];
    const found = subAdmins.find((sa: any) => sa.code === code);
    if (!found) return cors({ error: 'Code incorrect' }, 401, req);
    return cors({ ok: true, sub_admin_id: found.id, name: found.name, role: found.role, email: found.email, school_id: schoolData.id, school_name: schoolData.name, slug }, 200, req);
  }

  if (req.method === 'POST' && path.startsWith('/add-subadmin/')) {
    const slug = path.replace('/add-subadmin/', '').split('?')[0];
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouve' }, 404, req);
    const adminCode = req.headers.get('x-admin-code') || '';
    const isAdmin = adminCode === schoolData.admin_code || adminCode === schoolData.admin_password || authCheck(req);
    if (!isAdmin) return cors({ error: 'Non autorise' }, 401, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const subAdmin = { id: crypto.randomUUID(), name: sanitize(body.name || ''), role: sanitize(body.role || 'CPE'), email: sanitize(body.email || ''), code: (body.code || '').toUpperCase(), created_at: new Date().toISOString() };
    if (!subAdmin.name || !subAdmin.code) return cors({ error: 'Nom et code requis' }, 400, req);
    schoolData.sub_admins = [...(schoolData.sub_admins || []), subAdmin];
    await store.setJSON('school_' + entry.id, schoolData);
    return cors({ ok: true, sub_admin: subAdmin }, 201, req);
  }

  if (req.method === 'POST' && path.startsWith('/staff-login/')) {
    const slug = path.replace('/staff-login/', '').split('?')[0];
    const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
    const entry = index.find((e: any) => e.slug === slug && e.is_active);
    if (!entry) return cors({ error: 'Etablissement non trouve' }, 404, req);
    const schoolData = (await store.get('school_' + entry.id, { type: 'json' })) as any;
    if (!schoolData) return cors({ error: 'Non trouve' }, 404, req);
    let body: any;
    try { body = await req.json(); } catch { return cors({ error: 'Corps invalide' }, 400, req); }
    const code = (body.code || '').trim().toUpperCase();
    if (!code) return cors({ error: 'Code requis' }, 400, req);
    const sub = (schoolData.sub_admins || []).find((s: any) => s.code === code);
    if (!sub) return cors({ error: 'Code incorrect' }, 401, req);
    return cors({ ok: true, sub_admin_id: sub.id, name: sub.name, role: sub.role, email: sub.email, school_id: schoolData.id, school_name: schoolData.name, slug }, 200, req);
  }

  if (!authCheck(req)) {
      return cors({ error: 'Non autorisÃÂÃÂ©' }, 401, req);
    }

    if (req.method === 'GET' && (path === '' || path === '/')) {
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const schools = [];
      for (const entry of index) {
        const data = await store.get(`school_${entry.id}`, { type: 'json' });
        if (data) schools.push(data);
      }
      return cors(schools, 200, req);
    }

    if (req.method === 'GET' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const data = await store.get(`school_${id}`, { type: 'json' });
      if (!data) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);
      return cors(data, 200, req);
    }

    if (req.method === 'POST' && (path === '' || path === '/')) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return cors({ error: 'Corps de requÃÂÃÂªte invalide' }, 400, req);
      }

      if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
        return cors({ error: 'Nom requis (minimum 2 caractÃÂÃÂ¨res)' }, 400, req);
      }
      if (body.email && !isValidEmail(body.email)) {
        return cors({ error: "Format d'email invalide" }, 400, req);
      }
      if (body.admin_email && !isValidEmail(body.admin_email)) {
        return cors({ error: "Format d'email admin invalide" }, 400, req);
      }

      const name = sanitize(body.name.trim());
      const slug = sanitize(body.slug || genSlug(name)).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
      if (!slug || slug.length < 2) {
        return cors({ error: 'Sous-domaine invalide' }, 400, req);
      }

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      if (index.find((e: any) => e.slug === slug)) {
        return cors({ error: 'Sous-domaine dÃÂÃÂ©jÃÂÃÂ  utilisÃÂÃÂ©' }, 409, req);
      }

      const id = crypto.randomUUID();
      const adminCode = genAdminCode();
      const now = new Date().toISOString();
      const plan = body.plan || 'starter';
      const planDurations: Record<string, number> = { starter: 3, pro: 12, enterprise: 24 };
      const expDate = new Date();
      expDate.setMonth(expDate.getMonth() + (planDurations[plan] || 3));

      const schoolDomain = buildSchoolDomain(slug);
      const schoolUrl = buildSchoolUrl(slug);

      const school: any = {
        id,
        name,
        slug,
        domain: schoolDomain,
        url: schoolUrl,
        dns_target: NETLIFY_TARGET,
        tenant_base_domain: TENANT_BASE_DOMAIN,
        city: body.city || '',
        type: body.type || 'lycee',
        email: body.email || '',
        plan,
        status: plan === 'starter' ? 'trial' : 'active',
        is_active: true,
        admin_code: adminCode,
        admin_email: body.admin_email || body.email || '',
        admin_password: body.admin_password || adminCode,
        max_students: { starter: 200, pro: 9999, enterprise: 99999 }[plan] || 200,
        max_reports: { starter: 50, pro: 9999, enterprise: 99999 }[plan] || 50,
        max_admins: { starter: 1, pro: 2, enterprise: 99 }[plan] || 1,
        created_at: now,
        expires_at: expDate.toISOString(),
        report_count: 0,
        student_count: 0,
        staff_members: [],
        staff_codes: [],
      };

      await store.setJSON(`school_${id}`, school);
      index.push({
        id,
        name: school.name,
        slug: school.slug,
        city: school.city,
        type: school.type,
        plan: school.plan,
        is_active: true,
        status: school.status,
        created_at: now,
        domain: school.domain,
        url: school.url,
      });
      await store.setJSON('_index', index);

      syncToSupabase(school, store).catch(() => {});

      registerNetlifyDomain(slug).catch(() => {});
  return cors(school, 201, req);
    }

    if (req.method === 'PUT' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      const body = (await req.json()) as any;
      const updatedSlug = body.slug
        ? sanitize(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')
        : existing.slug;
      const updated = {
        ...existing,
        ...body,
        slug: updatedSlug,
        domain: buildSchoolDomain(updatedSlug),
        url: buildSchoolUrl(updatedSlug),
        tenant_base_domain: TENANT_BASE_DOMAIN,
        dns_target: NETLIFY_TARGET,
        id,
        updated_at: new Date().toISOString(),
      };
      await store.setJSON(`school_${id}`, updated);

      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const idx = index.findIndex((e: any) => e.id === id);
      if (idx >= 0) {
        index[idx] = {
          ...index[idx],
          name: updated.name,
          slug: updated.slug,
          city: updated.city,
          type: updated.type,
          plan: updated.plan,
          is_active: updated.is_active,
          status: updated.status,
          domain: updated.domain,
          url: updated.url,
        };
        await store.setJSON('_index', index);
      }

      return cors(updated, 200, req);
    }

    if (req.method === 'DELETE' && path.match(/^\/[a-zA-Z0-9_-]+$/)) {
      const id = path.slice(1);
      await store.delete(`school_${id}`);
      const index = ((await store.get('_index', { type: 'json' })) as any[]) || [];
      const filtered = index.filter((e: any) => e.id !== id);
      await store.setJSON('_index', filtered);
      return cors({ deleted: true }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/staff-codes$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      const body = (await req.json()) as any;
      const count = Math.min(body.count || 5, 50);
      const codes: any[] = existing.staff_codes || [];
      for (let i = 0; i < count; i++) {
        codes.push({
          code: 'STF-' + genAdminCode(),
          role: body.role || 'cpe',
          used: false,
          created_at: new Date().toISOString(),
        });
      }
      existing.staff_codes = codes;
      await store.setJSON(`school_${id}`, existing);
      return cors({ codes }, 200, req);
    }

    if (req.method === 'POST' && path.match(/^\/[a-zA-Z0-9_-]+\/regenerate-admin$/)) {
      const id = path.split('/')[1];
      const existing = (await store.get(`school_${id}`, { type: 'json' })) as any;
      if (!existing) return cors({ error: 'Non trouvÃÂÃÂ©' }, 404, req);

      existing.admin_code = genAdminCode();
      existing.admin_password = existing.admin_code;
      await store.setJSON(`school_${id}`, existing);
      return cors({ admin_code: existing.admin_code, admin_password: existing.admin_password }, 200, req);
    }

    return cors({ error: 'Route non trouvÃÂÃÂ©e' }, 404, req);
  } catch (error: any) {
    console.error('api-establishments error:', error);
    return cors(
      {
        success: false,
        error: error?.message || 'Internal server error',
        step: 'api-establishments',
      },
      500,
      req,
    );
  }
};

export const config: Config = {
  path: ['/api/establishments', '/api/establishments/*'],
};

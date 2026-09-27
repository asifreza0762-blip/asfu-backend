'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.SMMZZ_API_URL || 'https://www.smmzz.com/api/v2';
const API_KEY = String(process.env.SMMZZ_API_KEY || '').trim();
const MULTIPLIER = Number(process.env.PRICE_MULTIPLIER || 1.40);

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const PAYMENT_BUCKET = String(
  process.env.PAYMENT_SCREENSHOT_BUCKET || 'payment-screenshots'
).trim();

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'asifreza6741@gmail.com'
).trim().toLowerCase();

const ADMIN_PASSWORD_HASH = String(
  process.env.ADMIN_PASSWORD_HASH ||
  'ef07044ffff36393fe46fb8d9e2fac289f302ec7b85572955191584e312689e0'
).trim().toLowerCase();

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

function requireKey() {
  if (!API_KEY) {
    throw new Error('SMMZZ_API_KEY is not configured on the server');
  }
}

async function provider(params) {
  requireKey();

  const body = new URLSearchParams();
  body.set('key', API_KEY);

  for (const [name, value] of Object.entries(params || {})) {
    if (
      value !== undefined &&
      value !== null &&
      String(value) !== ''
    ) {
      body.set(name, String(value));
    }
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('SMMZZ returned a non-JSON response');
  }

  if (!response.ok) {
    throw new Error('SMMZZ HTTP ' + response.status);
  }

  if (data && data.error) {
    throw new Error(String(data.error));
  }

  return data;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function getBearer(req) {
  const h = String(req.headers.authorization || '');

  return /^Bearer\s+/i.test(h)
    ? h.replace(/^Bearer\s+/i, '').trim()
    : '';
}

async function requireUser(req, res) {
  if (!supabase) {
    res.status(503).json({
      error: 'Supabase is not configured on the server'
    });

    return null;
  }

  const token = getBearer(req);

  if (!token) {
    res.status(401).json({
      error: 'Authentication required'
    });

    return null;
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data || !data.user) {
      res.status(401).json({
        error: 'Invalid or expired session'
      });

      return null;
    }

    return data.user;
  } catch (e) {
    res.status(401).json({
      error: 'Invalid or expired session'
    });

    return null;
  }
}

function requireAdmin(req, res) {
  const token = String(
    req.headers['x-admin-session'] || ''
  ).trim();

  const row = adminSessions.get(token);

  if (!row || row.expiresAt < Date.now()) {
    if (token) {
      adminSessions.delete(token);
    }

    res.status(401).json({
      error: 'Admin session expired. Please login again.'
    });

    return false;
  }

  row.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;

  return true;
}

/* =========================
   HEALTH
========================= */

app.get('/api/health', async function (req, res) {
  let supabaseOk = false;

  if (supabase) {
    try {
      const result = await supabase
        .from('profiles')
        .select('id')
        .limit(1);

      supabaseOk = !result.error;
    } catch {
      supabaseOk = false;
    }
  }

  res.json({
    ok: true,
    configured: Boolean(API_KEY),
    provider: 'SMMZZ',
    supabaseConfigured: Boolean(supabase),
    supabaseConnected: supabaseOk,
    paymentBucket: PAYMENT_BUCKET,
    multiplier: MULTIPLIER
  });
});

/* =========================
   PAYMENT AUTH / ADMIN
========================= */

app.post('/api/admin/login', function (req, res) {
  const email = String(
    req.body?.email || ''
  ).trim().toLowerCase();

  const password = String(
    req.body?.password || ''
  );

  if (
    !email ||
    !password ||
    email !== ADMIN_EMAIL ||
    sha256(password) !== ADMIN_PASSWORD_HASH
  ) {
    return res.status(401).json({
      error: 'Invalid admin credentials'
    });
  }

  const token = crypto
    .randomBytes(32)
    .toString('hex');

  adminSessions.set(token, {
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });

  res.json({
    token,
    expiresIn: ADMIN_SESSION_TTL_MS
  });
});

app.post('/api/admin/logout', function (req, res) {
  const token = String(
    req.headers['x-admin-session'] || ''
  ).trim();

  if (token) {
    adminSessions.delete(token);
  }

  res.json({
    ok: true
  });
});

app.get('/api/admin/payments', async function (req, res) {
  if (!requireAdmin(req, res)) return;

  if (!supabase) {
    return res.status(503).json({
      error: 'Supabase is not configured on the server'
    });
  }

  try {
    const { data, error } = await supabase
      .from('payments')
      .select(
        'id,user_id,amount,payment_reference,utr,screenshot_url,status,created_at,updated_at'
      )
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    const payments = await Promise.all(
      (data || []).map(async p => {
        let screenshotUrl = '';

        if (p.screenshot_url) {
          const { data: signed } =
            await supabase.storage
              .from(PAYMENT_BUCKET)
              .createSignedUrl(
                p.screenshot_url,
                60 * 30
              );

          screenshotUrl =
            signed?.signedUrl || '';
        }

        return {
          ...p,
          screenshot_url: screenshotUrl
        };
      })
    );

    res.json({
      payments
    });

  } catch (e) {
    res.status(500).json({
      error:
        e.message ||
        'Could not load payments'
    });
  }
});

app.get('/api/payments/mine', async function (req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  try {
    const { data, error } = await supabase
      .from('payments')
      .select(
        'id,user_id,amount,payment_reference,utr,screenshot_url,status,created_at,updated_at'
      )
      .eq('user_id', user.id)
      .order('created_at', {
        ascending: false
      });

    if (error) throw error;

    res.json({
      payments: data || []
    });

  } catch (e) {
    res.status(500).json({
      error:
        e.message ||
        'Could not load your payments'
    });
  }
});

/* =========================
   CREATE PAYMENT
========================= */

app.post('/api/payment', async function (req, res) {
  const user = await requireUser(req, res);

  if (!user) return;

  try {
    const amount = Number(
      req.body?.amount
    );

    const utr = String(
      req.body?.utr || ''
    ).trim();

    const reference = String(
      req.body?.payment_reference || ''
    ).trim();

    const fileName = String(
      req.body?.file_name ||
      'screenshot.jpg'
    ).trim();

    const dataUrl = String(
      req.body?.file_data || ''
    );

    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({
        error: 'Invalid payment amount'
      });
    }

    if (!utr) {
      return res.status(400).json({
        error: 'UTR / transaction ID is required'
      });
    }

    if (!dataUrl) {
      return res.status(400).json({
        error: 'Payment screenshot is required'
      });
    }

    const match = dataUrl.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s
    );

    if (!match) {
      return res.status(400).json({
        error: 'Invalid screenshot data'
      });
    }

    const contentType =
      match[1].toLowerCase();

    const buffer = Buffer.from(
      match[2],
      'base64'
    );

    if (!buffer.length) {
      return res.status(400).json({
        error: 'Empty screenshot'
      });
    }

    if (buffer.length > 8 * 1024 * 1024) {
      return res.status(413).json({
        error:
          'Screenshot must be 8MB or smaller'
      });
    }

    const extMap = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/heic': 'heic',
      'image/heif': 'heif'
    };

    const ext =
      extMap[contentType] || 'jpg';

    const safeOriginal =
      fileName
        .replace(
          /[^a-zA-Z0-9._-]/g,
          '_'
        )
        .slice(-80);

    const objectPath =
      `${user.id}/` +
      `${Date.now()}-` +
      `${crypto.randomUUID()}-` +
      `${safeOriginal || 'screenshot.' + ext}`;

    const upload =
      await supabase.storage
        .from(PAYMENT_BUCKET)
        .upload(
          objectPath,
          buffer,
          {
            contentType,
            upsert: false
          }
        );

    if (upload.error) {
      throw upload.error;
    }

    const insert =
      await supabase
        .from('payments')
        .insert({
          user_id: user.id,
          amount,
          payment_reference:
            reference || null,
          utr,
          screenshot_url:
            objectPath,
          status: 'Pending'
        })
        .select(
          'id,user_id,amount,payment_reference,utr,screenshot_url,status,created_at,updated_at'
        )
        .single();

    if (insert.error) {
      await supabase.storage
        .from(PAYMENT_BUCKET)
        .remove([objectPath]);

      throw insert.error;
    }

    res.json({
      ok: true,
      payment: insert.data
    });

  } catch (e) {
    res.status(500).json({
      error:
        e.message ||
        'Payment request failed'
    });
  }
});

/* =========================
   APPROVE / REJECT PAYMENT
========================= */

app.post(
  '/api/admin/payments/:id/status',
  async function (req, res) {

    if (!requireAdmin(req, res)) return;

    if (!supabase) {
      return res.status(503).json({
        error:
          'Supabase is not configured on the server'
      });
    }

    const id = String(
      req.params.id || ''
    ).trim();

    const status = String(
      req.body?.status || ''
    ).trim();

    if (
      !id ||
      !['Approved', 'Rejected']
        .includes(status)
    ) {
      return res.status(400).json({
        error:
          'Invalid payment status'
      });
    }

    try {
      const { data: existing, error: getError } =
        await supabase
          .from('payments')
          .select(
            'id,user_id,amount,status'
          )
          .eq('id', id)
          .single();

      if (getError) throw getError;

      if (existing.status !== 'Pending') {
        return res.status(409).json({
          error:
            'Payment already reviewed'
        });
      }

      const { data, error } =
        await supabase
          .from('payments')
          .update({
            status,
            updated_at:
              new Date().toISOString()
          })
          .eq('id', id)
          .select(
            'id,user_id,amount,status,updated_at'
          )
          .single();

      if (error) throw error;

      if (status === 'Approved') {

        const profile =
          await supabase
            .from('profiles')
            .select(
              'id,balance'
            )
            .eq(
              'id',
              existing.user_id
            )
            .maybeSingle();

        if (
          !profile.error &&
          profile.data &&
          typeof profile.data.balance ===
            'number'
        ) {

          const nextBalance =
            Number(profile.data.balance) +
            Number(existing.amount);

          const balanceUpdate =
            await supabase
              .from('profiles')
              .update({
                balance:
                  nextBalance
              })
              .eq(
                'id',
                existing.user_id
              );

          if (balanceUpdate.error) {
            console.error(
              'Profile balance update failed:',
              balanceUpdate.error.message
            );
          }
        }
      }

      res.json({
        ok: true,
        payment: data
      });

    } catch (e) {
      res.status(500).json({
        error:
          e.message ||
          'Could not update payment'
      });
    }
  }
);

/* =========================
   SERVICES
========================= */

app.get('/api/services', async function (req, res) {
  try {
    const list =
      await provider({
        action: 'services'
      });

    const grouped = {};

    for (
      const service of
      Array.isArray(list)
        ? list
        : []
    ) {

      const category =
        String(
          service.category ||
          'Other'
        );

      const providerRate =
        Number(
          service.rate || 0
        );

      if (!Number.isFinite(providerRate)) {
        continue;
      }

      if (!grouped[category]) {
        grouped[category] = [];
      }

      const ratePer1k =
        providerRate * MULTIPLIER;

      grouped[category].push({
        providerServiceId:
          String(service.service),

        name:
          String(
            service.name ||
            ('Service ' +
              service.service)
          ),

        type:
          String(
            service.type ||
            'Default'
          ),

        providerRate,

        ratePer1k,

        ratePerUnit:
          ratePer1k / 1000,

        min:
          Number(service.min || 0),

        max:
          Number(service.max || 0)
      });
    }

    res.json({
      services: grouped,
      currency: 'INR',
      providerCurrency: 'INR',
      multiplier: MULTIPLIER
    });

  } catch (e) {
    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   ORDER
========================= */

app.post('/api/order', async function (req, res) {

  try {

    const body = req.body || {};

    const service =
      body.service;

    const url =
      body.url;

    const quantity =
      body.quantity;

    const comments =
      body.comments || '';

    const interval =
      body.interval || '';

    if (
      !service ||
      !url ||
      !quantity
    ) {
      return res.status(400).json({
        error:
          'service, url and quantity are required'
      });
    }

    const params = {
      action: 'add',
      service:
        String(service),
      link:
        String(url),
      quantity:
        String(quantity)
    };

    if (comments) {
      params.comments =
        String(comments);
    }

    if (interval) {
      params.interval =
        String(interval);
    }

    const data =
      await provider(params);

    res.json({
      order: data.order
    });

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   STATUS
========================= */

app.post('/api/status', async function (req, res) {

  try {

    const order =
      req.body &&
      req.body.order;

    if (!order) {
      return res.status(400).json({
        error:
          'order is required'
      });
    }

    res.json(
      await provider({
        action: 'status',
        order:
          String(order)
      })
    );

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

app.post('/api/status/bulk', async function (req, res) {

  try {

    const input =
      req.body &&
      req.body.orders;

    const orders =
      Array.isArray(input)
        ? input
            .filter(Boolean)
            .slice(0, 100)
        : [];

    if (!orders.length) {
      return res.json({
        orders: {}
      });
    }

    const data =
      await provider({
        action: 'status',
        orders:
          orders.join(',')
      });

    res.json({
      orders: data
    });

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   BALANCE
========================= */

app.get('/api/balance', async function (req, res) {

  try {

    res.json(
      await provider({
        action: 'balance'
      })
    );

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   REFILL
========================= */

app.post('/api/refill', async function (req, res) {

  try {

    const order =
      req.body &&
      req.body.order
        ? String(req.body.order)
        : '';

    res.json(
      await provider({
        action: 'refill',
        order
      })
    );

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   CANCEL
========================= */

app.post('/api/cancel', async function (req, res) {

  try {

    const order =
      req.body &&
      req.body.order
        ? String(req.body.order)
        : '';

    res.json(
      await provider({
        action: 'cancel',
        order
      })
    );

  } catch (e) {

    res.status(502).json({
      error: e.message
    });
  }
});

/* =========================
   FRONTEND
========================= */

app.get('*', function (req, res) {
  res.sendFile(
    path.join(
      __dirname,
      'index.html'
    )
  );
});

/* =========================
   START
========================= */

app.listen(PORT, function () {

  console.log(
    'ASFU SMMZZ backend running on port ' +
    PORT
  );

  console.log(
    'Supabase configured: ' +
    Boolean(supabase)
  );

  console.log(
    'Customer multiplier: ' +
    MULTIPLIER
  );
});

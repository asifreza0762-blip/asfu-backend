'use strict';

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);

const API_URL =
  process.env.SMMZZ_API_URL ||
  'https://www.smmzz.com/api/v2';

const API_KEY =
  String(process.env.SMMZZ_API_KEY || '').trim();

/* =========================
   PRICE SETTINGS
   SMMZZ LIVE RATE IS USED
   AS INR / 1K
   CUSTOMER MARGIN = 40%
========================= */

const MULTIPLIER =
  Number(process.env.PRICE_MULTIPLIER || 1.40);

/* =========================
   SUPABASE
========================= */

const SUPABASE_URL =
  String(process.env.SUPABASE_URL || '').trim();

const SUPABASE_SERVICE_ROLE_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

/* =========================
   MIDDLEWARE
========================= */

app.use(
  express.json({
    limit: '1mb'
  })
);

app.use(
  express.urlencoded({
    extended: false
  })
);

/* =========================
   FRONTEND
========================= */

app.use(express.static(__dirname));

/* =========================
   SMMZZ HELPER
========================= */

function requireKey() {
  if (!API_KEY) {
    throw new Error(
      'SMMZZ_API_KEY is not configured on the server'
    );
  }
}

async function provider(params) {
  requireKey();

  const body = new URLSearchParams();

  body.set('key', API_KEY);

  for (
    const [name, value] of Object.entries(params || {})
  ) {
    if (
      value !== undefined &&
      value !== null &&
      String(value) !== ''
    ) {
      body.set(
        name,
        String(value)
      );
    }
  }

  const response = await fetch(
    API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      'SMMZZ returned a non-JSON response'
    );
  }

  if (!response.ok) {
    throw new Error(
      'SMMZZ HTTP ' +
      response.status
    );
  }

  if (data && data.error) {
    throw new Error(
      String(data.error)
    );
  }

  return data;
}

/* =========================
   HEALTH
========================= */

app.get(
  '/api/health',
  async function (req, res) {

    let supabaseOk = false;

    if (supabase) {
      try {
        const result =
          await supabase
            .from('profiles')
            .select('id')
            .limit(1);

        supabaseOk =
          !result.error;
      } catch (error) {
        supabaseOk = false;
      }
    }

    res.json({
      ok: true,
      configured: Boolean(API_KEY),
      provider: 'SMMZZ',
      supabaseConfigured: Boolean(supabase),
      supabaseConnected: supabaseOk,
      multiplier: MULTIPLIER
    });
  }
);

/* =========================
   SERVICES
========================= */

app.get(
  '/api/services',
  async function (req, res) {

    try {

      const list =
        await provider({
          action: 'services'
        });

      const grouped = {};

      for (
        const service
        of Array.isArray(list)
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

        if (
          !Number.isFinite(
            providerRate
          )
        ) {
          continue;
        }

        if (
          !grouped[category]
        ) {
          grouped[category] = [];
        }

        /* =========================
           FINAL CUSTOMER PRICE
           SMMZZ RATE = INR / 1K
           + 40% MARGIN
        ========================= */

        const ratePer1k =
          providerRate *
          MULTIPLIER;

        const ratePerUnit =
          ratePer1k / 1000;

        grouped[category].push({

          providerServiceId:
            String(
              service.service
            ),

          name:
            String(
              service.name ||
              (
                'Service ' +
                service.service
              )
            ),

          type:
            String(
              service.type ||
              'Default'
            ),

          providerRate:
            providerRate,

          ratePer1k:
            ratePer1k,

          ratePerUnit:
            ratePerUnit,

          min:
            Number(
              service.min || 0
            ),

          max:
            Number(
              service.max || 0
            )
        });
      }

      res.json({
        services: grouped,
        currency: 'INR',
        providerCurrency: 'INR',
        multiplier: MULTIPLIER
      });

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   ORDER
========================= */

app.post(
  '/api/order',
  async function (req, res) {

    try {

      const body =
        req.body || {};

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

        /* SMMZZ ADD ORDER USES "link" */
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
        order:
          data.order
      });

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   STATUS
========================= */

app.post(
  '/api/status',
  async function (req, res) {

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

      const data =
        await provider({
          action: 'status',
          order:
            String(order)
        });

      res.json(data);

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   BULK STATUS
========================= */

app.post(
  '/api/status/bulk',
  async function (req, res) {

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
        orders:
          data
      });

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   BALANCE
========================= */

app.get(
  '/api/balance',
  async function (req, res) {

    try {

      const data =
        await provider({
          action: 'balance'
        });

      res.json(data);

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   REFILL
========================= */

app.post(
  '/api/refill',
  async function (req, res) {

    try {

      const order =
        req.body &&
        req.body.order
          ? String(
              req.body.order
            )
          : '';

      const data =
        await provider({
          action: 'refill',
          order:
            order
        });

      res.json(data);

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   CANCEL
========================= */

app.post(
  '/api/cancel',
  async function (req, res) {

    try {

      const order =
        req.body &&
        req.body.order
          ? String(
              req.body.order
            )
          : '';

      const data =
        await provider({
          action: 'cancel',
          order:
            order
        });

      res.json(data);

    } catch (error) {

      res.status(502).json({
        error:
          error.message
      });
    }
  }
);

/* =========================
   FRONTEND FALLBACK
========================= */

app.get(
  '*',
  function (req, res) {

    res.sendFile(
      path.join(
        __dirname,
        'index.html'
      )
    );
  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  function () {

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
  }
);

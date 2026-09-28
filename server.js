'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.SMMZZ_API_URL || 'https://www.smmzz.com/api/v2';
const API_KEY = String(process.env.SMMZZ_API_KEY || '').trim();

const FX = 0.85;
const MULTIPLIER = 1.6666666667;

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
    if (value !== undefined && value !== null && String(value) !== '') {
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
  } catch (error) {
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

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const ADMIN_EMAIL = 'asifreza6741@gmail.com';
const ADMIN_PASS_HASH = 'ef07044ffff36393fe46fb8d9e2fac289f302ec7b85572955191584e312689e0';
const adminTokens = new Map();

function requireSupabase(){
  if(!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase server configuration is missing');
  }
}

async function supabaseRequest(pathname, options={}){
  requireSupabase();

  const headers = Object.assign({
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, options.headers || {});

  const response = await fetch(
    SUPABASE_URL + pathname,
    Object.assign({}, options, {headers})
  );

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch(e) {
    data = text;
  }

  if(!response.ok) {
    throw new Error(
      (data && (data.message || data.error || data.msg)) ||
      ('Supabase HTTP ' + response.status)
    );
  }

  return data;
}

async function getSupabaseUser(token){
  if(!token) throw new Error('Authentication required');

  requireSupabase();

  const response = await fetch(
    SUPABASE_URL + '/auth/v1/user',
    {
      headers:{
        apikey:SUPABASE_SERVICE_ROLE_KEY,
        Authorization:'Bearer '+token
      }
    }
  );

  const data = await response.json().catch(()=>({}));

  if(!response.ok || !data.id) {
    throw new Error('Invalid or expired session');
  }

  return data;
}

function bearer(req){
  const h=String(req.headers.authorization||'');
  return h.startsWith('Bearer ')?h.slice(7).trim():'';
}

function adminUser(req){
  const token=bearer(req);
  const item=adminTokens.get(token);

  if(!item || item.expiresAt<Date.now()){
    if(token) adminTokens.delete(token);
    return false;
  }

  return true;
}

function safeFileName(name){
  return String(name||'screenshot.jpg')
    .replace(/[^a-zA-Z0-9._-]/g,'_')
    .slice(-120) || 'screenshot.jpg';
}

app.post('/api/admin/login', async function(req,res){
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const password=String(req.body?.password||'');

    const hash=crypto
      .createHash('sha256')
      .update(password)
      .digest('hex');

    if(email!==ADMIN_EMAIL || hash!==ADMIN_PASS_HASH) {
      return res.status(401).json({
        error:'Invalid email or password'
      });
    }

    const token=crypto.randomBytes(32).toString('hex');

    adminTokens.set(token,{
      expiresAt:Date.now()+1000*60*60*24*7
    });

    res.json({token});
  }catch(error){
    res.status(500).json({error:error.message});
  }
});

app.post('/api/payments', async function(req,res){
  try{
    const user=await getSupabaseUser(bearer(req));

    const amount=Number(req.body?.amount||0);
    const utr=String(req.body?.utr||'').trim();
    const url=String(req.body?.url||'').trim();
    const paymentReference=String(req.body?.referenceCode||'').trim();
    const fileName=safeFileName(req.body?.fileName);
    const fileData=String(req.body?.fileData||'');

    if(!Number.isFinite(amount)||amount<1) {
      return res.status(400).json({
        error:'Invalid payment amount'
      });
    }

    if(!utr) {
      return res.status(400).json({
        error:'UTR is required'
      });
    }

    if(!fileData) {
      return res.status(400).json({
        error:'Payment screenshot is required'
      });
    }

    const match=fileData.match(
      /^data:([^;]+);base64,(.+)$/
    );

    if(!match) {
      return res.status(400).json({
        error:'Invalid screenshot data'
      });
    }

    const mime=match[1]||'image/jpeg';
    const buffer=Buffer.from(match[2],'base64');

    if(buffer.length>8*1024*1024) {
      return res.status(400).json({
        error:'Screenshot must be under 8MB'
      });
    }

    const ext=(fileName.match(
      /\.([a-zA-Z0-9]+)$/
    )||[])[1]||'jpg';

    const objectPath=
      user.id+'/'+Date.now()+'-'+
      crypto.randomBytes(5).toString('hex')+'.'+ext;

    await supabaseRequest(
      '/storage/v1/object/payment-screenshots/'+objectPath,
      {
        method:'POST',
        headers:{
          'Content-Type':mime,
          x_upsert:'false'
        },
        body:buffer
      }
    );

    const rows=await supabaseRequest(
      '/rest/v1/payments',
      {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          Prefer:'return=representation'
        },
        body:JSON.stringify({
          user_id:user.id,
          amount,
          payment_reference:paymentReference||null,
          utr,
          screenshot_url:objectPath,
          status:'Pending'
        })
      }
    );

    const row=Array.isArray(rows)?rows[0]:rows;

    res.json({
      payment:{
        id:row.id,
        userId:row.user_id,
        amount:Number(row.amount),
        paymentReference:row.payment_reference||'',
        utr:row.utr,
        screenshotUrl:objectPath,
        url,
        status:row.status,
        createdAt:row.created_at,
        fileName
      }
    });

  }catch(error){
    res.status(500).json({
      error:error.message||'Could not submit payment'
    });
  }
});

app.get('/api/payments', async function(req,res){
  try{
    const user=await getSupabaseUser(bearer(req));

    const rows=await supabaseRequest(
      '/rest/v1/payments?select=id,user_id,amount,payment_reference,utr,status,created_at,updated_at&user_id=eq.'+
      encodeURIComponent(user.id)+
      '&order=created_at.desc'
    );

    res.json({payments:rows});

  }catch(error){
    res.status(500).json({error:error.message});
  }
});

app.get('/api/admin/payments', async function(req,res){
  try{
    if(!adminUser(req)) {
      return res.status(401).json({
        error:'Admin session expired'
      });
    }

    const rows=await supabaseRequest(
      '/rest/v1/payments?select=id,user_id,amount,payment_reference,utr,screenshot_url,status,created_at,updated_at&order=created_at.desc'
    );

    const payments=[];

    for(const row of (Array.isArray(rows)?rows:[])){
      let userName='';
      let userEmail='';

      try{
        const profiles=await supabaseRequest(
          '/rest/v1/profiles?select=name,email&id=eq.'+
          encodeURIComponent(row.user_id)+
          '&limit=1'
        );

        const profile=Array.isArray(profiles)?profiles[0]:profiles;

        userName=profile?.name||'';
        userEmail=profile?.email||'';

      }catch(e){}

      let screenshotUrl='';

      if(row.screenshot_url){
        try{
          const signed=await supabaseRequest(
            '/storage/v1/object/sign/payment-screenshots/'+
            row.screenshot_url,
            {
              method:'POST',
              headers:{
                'Content-Type':'application/json'
              },
              body:JSON.stringify({
                expiresIn:3600
              })
            }
          );

          screenshotUrl=signed?.signedURL
            ? SUPABASE_URL+'/storage/v1'+signed.signedURL
            : (signed?.signedUrl||'');

          if(
            screenshotUrl &&
            !/^https?:\/\//i.test(screenshotUrl)
          ){
            screenshotUrl=SUPABASE_URL+screenshotUrl;
          }

        }catch(e){}
      }

      payments.push({
        id:row.id,
        userId:row.user_id,
        userName,
        userEmail,
        amount:Number(row.amount),
        paymentReference:row.payment_reference||'',
        utr:row.utr||'',
        status:row.status,
        screenshotUrl,
        createdAt:row.created_at,
        updatedAt:row.updated_at
      });
    }

    res.json({payments});

  }catch(error){
    res.status(500).json({error:error.message});
  }
});

app.patch('/api/admin/payments/:id', async function(req,res){
  try{
    if(!adminUser(req)) {
      return res.status(401).json({
        error:'Admin session expired'
      });
    }

    const status=String(req.body?.status||'');

    if(!['Approved','Rejected'].includes(status)) {
      return res.status(400).json({
        error:'Invalid payment status'
      });
    }

    const id=encodeURIComponent(req.params.id);

    const rows=await supabaseRequest(
      '/rest/v1/payments?select=id,user_id,amount,status&id='+
      id+
      '&limit=1'
    );

    const payment=Array.isArray(rows)?rows[0]:rows;

    if(!payment) {
      return res.status(404).json({
        error:'Payment not found'
      });
    }

    if(payment.status!=='Pending') {
      return res.status(400).json({
        error:'Payment already reviewed'
      });
    }

    if(status==='Approved'){
      const profiles=await supabaseRequest(
        '/rest/v1/profiles?select=id,balance&id=eq.'+
        encodeURIComponent(payment.user_id)+
        '&limit=1'
      );

      const profile=Array.isArray(profiles)?profiles[0]:profiles;

      if(!profile) {
        return res.status(400).json({
          error:'Customer profile not found'
        });
      }

      const balance=
        Number(profile.balance||0)+
        Number(payment.amount||0);

      await supabaseRequest(
        '/rest/v1/profiles?id=eq.'+
        encodeURIComponent(payment.user_id),
        {
          method:'PATCH',
          headers:{
            'Content-Type':'application/json',
            Prefer:'return=minimal'
          },
          body:JSON.stringify({balance})
        }
      );
    }

    await supabaseRequest(
      '/rest/v1/payments?id='+id,
      {
        method:'PATCH',
        headers:{
          'Content-Type':'application/json',
          Prefer:'return=minimal'
        },
        body:JSON.stringify({
          status,
          updated_at:new Date().toISOString()
        })
      }
    );

    res.json({
      ok:true,
      status
    });

  }catch(error){
    res.status(500).json({
      error:error.message
    });
  }
});

app.get('/api/health', function (req, res) {
  res.json({
    ok: true,
    configured: Boolean(API_KEY),
    provider: 'SMMZZ'
  });
});

app.get('/api/services', async function (req, res) {

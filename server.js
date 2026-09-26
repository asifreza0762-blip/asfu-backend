const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.SMMZZ_API_URL || 'https://www.smmzz.com/api/v2';
const API_KEY = process.env.SMMZZ_API_KEY || '';
const FX = Number(process.env.PROVIDER_TO_INR || 85);
const MULTIPLIER = Number(process.env.PRICE_MULTIPLIER || 1);

app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname,'public')));

function requireKey(){
  if(!API_KEY) throw new Error('SMMZZ_API_KEY is not configured on the server');
}

async function provider(params){
  requireKey();
  const body = new URLSearchParams({key:API_KEY, ...params});
  const r = await fetch(API_URL,{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body
  });
  const text = await r.text();
  let data;
  try{
    data=JSON.parse(text)
  }catch{
    throw new Error('SMMZZ returned a non-JSON response')
  }
  if(!r.ok) throw new Error(`SMMZZ HTTP ${r.status}`);
  if(data && data.error) throw new Error(data.error);
  return data;
}

app.get('/api/health', async (req,res)=>{
  res.json({
    ok:true,
    configured:Boolean(API_KEY),
    provider:'SMMZZ'
  });
});

app.get('/api/services', async (req,res)=>{
  try{
    const list=await provider({action:'services'});
    const grouped={};

    for(const s of Array.isArray(list)?list:[]){
      const category=String(s.category||'Other');
      const providerRate=Number(s.rate||0);

      if(!Number.isFinite(providerRate)) continue;

      (grouped[category] ||= []).push({
        providerServiceId:String(s.service),
        name:String(s.name||`Service ${s.service}`),
        type:String(s.type||'Default'),
        providerRate,
        ratePer1k:providerRate*FX*MULTIPLIER,
        ratePerUnit:providerRate*FX*MULTIPLIER/1000,
        min:Number(s.min||0),
        max:Number(s.max||0)
      });
    }

    res.json({
      services:grouped,
      currency:'INR',
      providerCurrency:'USD',
      fx:FX,
      multiplier:MULTIPLIER
    });

  }catch(e){
    res.status(502).json({error:e.message})
  }
});

app.post('/api/order', async (req,res)=>{
  try{
    const {
      service,
      url,
      quantity,
      comments='',
      interval=''
    }=req.body||{};

    if(!service||!url||!quantity){
      return res.status(400).json({
        error:'service, url and quantity are required'
      });
    }

    const data=await provider({
      action:'add',
      service:String(service),
      url:String(url),
      quantity:String(quantity),
      ...(comments?{comments:String(comments)}:{}),
      ...(interval?{interval:String(interval)}:{})
    });

    res.json({order:data.order});

  }catch(e){
    res.status(502).json({error:e.message})
  }
});

app.post('/api/status', async (req,res)=>{
  try{

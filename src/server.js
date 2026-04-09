 'use strict';
 
 const express = require('express');
 
 function createServer({ bridgeCore, maxWebhookSecret }) {
   const app = express();
   app.use(express.json({ limit: '20mb' }));
 
   app.post('/webhook', async (req, res) => {
     // ACK ASAP for both Chatwoot and platform webhooks.
     res.status(200).send('OK');
 
     // 1) Try platform webhook (MAX now; Telegram/WhatsApp/VK later via adapter).
    const looksLikePlatform = req.body && typeof req.body === 'object' && !!req.body.update_type;
     if (looksLikePlatform) {
       try {
         if (maxWebhookSecret) {
           const headerSecret = req.get('X-Max-Bot-Api-Secret');
           if (headerSecret !== maxWebhookSecret) {
             console.warn('[MAX WEBHOOK] invalid secret');
             return;
           }
         }
 
        const ut = req.body.update_type || 'unknown';
        const mid = req.body?.message?.body?.mid;
        const senderId = req.body?.message?.sender?.user_id || req.body?.message?.sender?.id;
        console.log('[MAX WEBHOOK] received', { update_type: ut, senderId, mid });
 
        const handled = await bridgeCore.handlePlatformWebhook(req.body);
        if (!handled) {
          console.warn('[MAX WEBHOOK] ignored: unsupported payload shape', {
            update_type: ut,
            hasMessage: !!req.body?.message
          });
        }
       } catch (err) {
         console.error('[MAX WEBHOOK ERROR]', err.response?.status, err.response?.data || err.message);
       }
       return;
     }
 
     // 2) Chatwoot webhook
     try {
       const convId = req.body?.conversation?.id;
       const msgId = req.body?.id;
       if (req.body?.event || req.body?.conversation) {
         console.log('[CW WEBHOOK] received', {
           event: req.body?.event,
           message_type: req.body?.message_type,
           convId,
           msgId
         });
       }
 
       await bridgeCore.handleChatwootWebhook(req.body);
     } catch (err) {
       console.error('[CW WEBHOOK ERROR]', err.response?.status, err.response?.data || err.message);
     }
   });
 
   app.get('/health', (_, res) => res.json({ ok: true }));
 
   return app;
 }
 
 module.exports = {
   createServer
 };

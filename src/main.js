 'use strict';
 
 const { required, optional, optionalInt } = require('./config');
 const { createState } = require('./state/state');
 const { ChatwootClient } = require('./helpdesk/chatwootClient');
 const { MaxClient } = require('./platforms/max/maxClient');
 const { MaxAdapter } = require('./platforms/max/maxAdapter');
 const { BridgeCore } = require('./bridge/bridgeCore');
 const { createServer } = require('./server');
 
 async function main() {
   const state = createState();
   state.reverseMap.load();
   state.processed.load();
  state.maxMidToCwMessageMap.load();
 
   if (state.reverseMap.map.size > 0) console.log('[map] restored', state.reverseMap.map.size);
 
   const chatwootUrl = required('CHATWOOT_URL');
   const chatwootToken = required('CHATWOOT_TOKEN');
   const chatwootAccount = optionalInt('CHATWOOT_ACCOUNT', 1);
   const chatwootInboxId = optionalInt('CHATWOOT_INBOX_ID', 1);
 
   const maxToken = optional('MAX_TOKEN');
   const maxApiUrl = optional('MAX_API_URL', 'https://botapi.max.ru');
   const maxWebhookSecret = optional('MAX_WEBHOOK_SECRET', '');
 
   const cw = new ChatwootClient({
     baseUrl: chatwootUrl,
     accountId: chatwootAccount,
     accessToken: chatwootToken,
     inboxId: chatwootInboxId
   });
 
   const maxClient = new MaxClient({ baseUrl: maxApiUrl, token: maxToken });
   const maxAdapter = new MaxAdapter({ maxClient, chatwootClient: cw, state });
 
   const bridgeCore = new BridgeCore({ helpdesk: cw, platform: maxAdapter, state });
 
   const app = createServer({ bridgeCore, maxWebhookSecret });
 
   console.log('Bridge started');
   const port = 3000;
   app.listen(port, () => console.log('Webhook listening on :' + port));
 
   // Chatwoot outgoing polling (operators -> platform)
   // Webhook exists too, but polling provides fallback when webhooks are misconfigured.
   console.log('Chatwoot outgoing polling enabled');
   const tick = async () => {
     await bridgeCore.pollChatwootOutgoing();
     setTimeout(tick, 5000);
   };
   setTimeout(tick, 3000);
 
   // MAX polling fallback only when webhook secret not configured.
   if (!maxWebhookSecret) {
     // Keep legacy behavior in case webhook isn't configured.
     let marker;
     const poll = async () => {
       try {
         const res = await maxClient.pollUpdates({ marker });
         marker = res.marker;
         for (const update of res.updates || []) {
          if (update?.update_type) {
            await maxAdapter.handleUpdate(update.update_type, update);
          }
         }
       } catch (err) {
         console.error('[poll MAX error]', err.response?.status, err.response?.data || err.message);
       }
       setImmediate(poll);
     };
     poll();
   } else {
     console.log('[MAX] webhook mode enabled');
   }
 }
 
 module.exports = { main };
 
 if (require.main === module) {
   main().catch(err => {
     console.error('Fatal:', err.response?.status, err.response?.data || err.message);
     process.exit(1);
   });
 }

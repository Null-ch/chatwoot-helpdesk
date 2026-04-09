 'use strict';
 
 const { JsonMapStore } = require('../storage/jsonMapStore');
 const { ProcessedStore } = require('../storage/processedStore');
 
 function createState() {
   const reverseMap = new JsonMapStore('/tmp/reverse_map.json', { castNumberKeys: true });
   const processedMap = new JsonMapStore('/tmp/processed_messages.json', { castNumberKeys: false });
  const maxMidToCwMessageMap = new JsonMapStore('/tmp/max_mid_to_cw_message.json', { castNumberKeys: false });
 
   const processed = new ProcessedStore(processedMap);
 
   return {
     conversationMap: new Map(),
     reverseMap,
     lastMidMap: new Map(),
     chatTitleCache: new Map(),
     chatNameMap: new Map(),
     processed,
    chatwootBaselineMap: new Map(),
    maxMidToCwMessageMap
   };
 }
 
 module.exports = {
   createState
 };

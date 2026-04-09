 'use strict';
 
 const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
 
 class ProcessedStore {
   constructor(jsonMapStore) {
     this.store = jsonMapStore;
   }
 
   load() {
     this.store.load();
   }
 
   save() {
     this.store.save();
   }
 
   prune() {
     const now = Date.now();
     for (const [k, v] of this.store.map.entries()) {
       if (!v?.updatedAt || now - v.updatedAt > WEEK_MS) {
         this.store.map.delete(k);
       }
     }
   }
 
   get(msgId) {
     return this.store.map.get(String(msgId)) || { textSent: false, attachmentsSent: false, updatedAt: 0 };
   }
 
   mark(msgId, patch) {
     if (msgId === undefined || msgId === null) return;
     const key = String(msgId);
     const prev = this.get(key);
     this.store.map.set(key, { ...prev, ...patch, updatedAt: Date.now() });
     this.save();
   }
 }
 
 module.exports = {
   ProcessedStore
 };

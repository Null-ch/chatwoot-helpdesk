 'use strict';
 
 const fs = require('fs');
 
 class JsonMapStore {
   constructor(filePath, { castNumberKeys = false } = {}) {
     this.filePath = filePath;
     this.castNumberKeys = castNumberKeys;
     this.map = new Map();
   }
 
   load() {
     try {
       const obj = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
       this.map.clear();
       for (const [k, v] of Object.entries(obj)) {
         this.map.set(this.castNumberKeys ? Number(k) : k, v);
       }
     } catch (_) {}
   }
 
   save() {
     try {
       const obj = {};
       this.map.forEach((v, k) => { obj[k] = v; });
       fs.writeFileSync(this.filePath, JSON.stringify(obj));
     } catch (e) {
       console.error('[JsonMapStore save error]', this.filePath, e.message);
     }
   }
 }
 
 module.exports = {
   JsonMapStore
 };

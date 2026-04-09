 'use strict';
 
 function required(name) {
   const v = process.env[name];
   if (v === undefined || v === null || v === '') {
     throw new Error(`Missing env: ${name}`);
   }
   return v;
 }
 
 function optional(name, fallback = undefined) {
   const v = process.env[name];
   return (v === undefined || v === null || v === '') ? fallback : v;
 }
 
 function optionalInt(name, fallback = undefined) {
   const v = optional(name, undefined);
   if (v === undefined) return fallback;
   const n = parseInt(v, 10);
   return Number.isFinite(n) ? n : fallback;
 }
 
 module.exports = {
   required,
   optional,
   optionalInt
 };

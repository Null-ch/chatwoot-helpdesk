 'use strict';
 
 function normalizeText(text) {
   if (typeof text !== 'string') return '';
   return text.replace(/\r/g, '').trim();
 }
 
 module.exports = {
   normalizeText
 };

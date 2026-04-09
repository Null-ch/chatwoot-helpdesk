 'use strict';
 
 function getAttachmentUrl(att) {
   return (
     att?.data_url ||
     att?.file_url ||
     att?.thumb_url ||
     att?.url ||
     att?.download_url ||
     att?.data?.url ||
     att?.data?.file_url ||
     att?.payload?.url ||
     att?.blob_url ||
     null
   );
 }
 
function rewriteToInternalChatwootUrl(fileUrl) {
  // Only rewrite URLs that actually point to Chatwoot-served assets.
  // Platform CDN URLs (e.g. MAX) must not be rewritten to the chatwoot container.
  try {
    const raw = String(fileUrl || '').trim();
    if (!raw) return '';

    if (raw.startsWith('/')) {
      return `http://chatwoot:3000${raw}`;
    }

    const u = new URL(String(fileUrl));
    const p = u.pathname || '';
    const looksLikeChatwootAsset = p.startsWith('/rails/active_storage') || p.startsWith('/uploads/');
    if (!looksLikeChatwootAsset) return u.toString();

    u.protocol = 'http:';
    u.host = 'chatwoot:3000';
    return u.toString();
  } catch (_) {
    return String(fileUrl || '');
  }
}

 module.exports = {
  getAttachmentUrl,
  rewriteToInternalChatwootUrl
 };

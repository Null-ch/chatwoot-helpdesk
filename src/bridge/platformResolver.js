'use strict';

function resolveDirection(messageType) {
  if (messageType === 'incoming' || messageType === 0) return 'incoming';
  if (messageType === 'outgoing' || messageType === 1) return 'outgoing';
  return 'unknown';
}

function resolvePlatform({ conversation, identifier, fallback = 'web' }) {
  const ident = String(
    identifier ||
      conversation?.meta?.sender?.identifier ||
      conversation?.contact_inbox?.source_id ||
      ''
  ).toLowerCase();

  const inboxName = String(conversation?.inbox?.name || '').toLowerCase();
  const channel = String(conversation?.meta?.channel || conversation?.channel || '').toLowerCase();

  if (ident.startsWith('max_') || inboxName.includes('max') || channel.includes('max')) return 'max';
  if (ident.includes('telegram') || ident.startsWith('tg_') || inboxName.includes('telegram') || channel.includes('telegram')) return 'tg';
  if (ident.includes('whatsapp') || inboxName.includes('whatsapp') || channel.includes('whatsapp')) return 'whatsapp';
  if (ident.includes('web') || inboxName.includes('web') || channel.includes('web')) return 'web';

  return fallback;
}

module.exports = {
  resolveDirection,
  resolvePlatform
};

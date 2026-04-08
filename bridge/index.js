'use strict';

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const MAX_TOKEN = process.env.MAX_TOKEN;
const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT = parseInt(process.env.CHATWOOT_ACCOUNT, 10);
const CHATWOOT_INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID, 10);
const MAX_API = process.env.MAX_API_URL || 'https://botapi.max.ru';

const conversationMap = new Map();
const reverseMap = new Map();
const lastMidMap = new Map();
const chatTitleCache = new Map();
const chatNameMap = new Map();
const processedMap = new Map();
const chatwootBaselineMap = new Map();

const MAP_FILE = '/tmp/reverse_map.json';
const PROCESSED_FILE = '/tmp/processed_messages.json';

function saveJsonMap(filePath, map) {
  try {
    const obj = {};
    map.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(filePath, JSON.stringify(obj));
  } catch (e) {
    console.error('[saveJsonMap error]', filePath, e.message);
  }
}

function loadJsonMap(filePath, map, castNumberKeys = false) {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    Object.entries(obj).forEach(([k, v]) => {
      map.set(castNumberKeys ? Number(k) : k, v);
    });
  } catch (_) {}
}

function saveReverseMap() {
  saveJsonMap(MAP_FILE, reverseMap);
}

function loadReverseMap() {
  loadJsonMap(MAP_FILE, reverseMap, true);
  if (reverseMap.size > 0) {
    console.log('[map] restored', reverseMap.size);
  }
}

function saveProcessedMap() {
  saveJsonMap(PROCESSED_FILE, processedMap);
}

function loadProcessedMap() {
  loadJsonMap(PROCESSED_FILE, processedMap, false);
  if (processedMap.size > 0) {
    console.log('[processed] restored', processedMap.size);
  }
}

function markProcessed(msgId, patch) {
  if (msgId === undefined || msgId === null) return;
  const key = String(msgId);
  const prev = processedMap.get(key) || {
    textSent: false,
    attachmentsSent: false,
    updatedAt: 0
  };

  processedMap.set(key, {
    ...prev,
    ...patch,
    updatedAt: Date.now()
  });

  saveProcessedMap();
}

function getProcessed(msgId) {
  return processedMap.get(String(msgId)) || {
    textSent: false,
    attachmentsSent: false,
    updatedAt: 0
  };
}

function pruneProcessedMap() {
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000;

  for (const [k, v] of processedMap.entries()) {
    if (!v?.updatedAt || now - v.updatedAt > maxAge) {
      processedMap.delete(k);
    }
  }
}

function normalizeContent(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\r/g, '').trim();
}

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

function detectMediaType(mime) {
  if (
    mime.includes('png') ||
    mime.includes('webp') ||
    mime.includes('gif') ||
    mime.includes('jpeg') ||
    mime.includes('jpg')
  ) return 'image';

  if (mime.includes('mp4')) return 'video';
  if (mime.includes('ogg') || mime.includes('mpeg') || mime.includes('mp3')) return 'audio';
  return 'file';
}

function detectExtension(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('pdf')) return 'pdf';
  return 'bin';
}

const maxApi = axios.create({
  baseURL: MAX_API,
  headers: { Authorization: MAX_TOKEN }
});

const cwApi = axios.create({
  baseURL: `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT}`,
  headers: {
    api_access_token: CHATWOOT_TOKEN,
    'Content-Type': 'application/json'
  }
});

async function getChatTitle(chatId) {
  if (chatTitleCache.has(chatId)) return chatTitleCache.get(chatId);

  try {
    const res = await maxApi.get(`/chats/${chatId}`);
    const title = res.data?.title || `Группа ${chatId}`;
    chatTitleCache.set(chatId, title);
    return title;
  } catch (_) {
    return `Группа ${chatId}`;
  }
}

async function findOrCreateContact(identifier, name) {
  try {
    const res = await cwApi.get('/contacts/search', {
      params: { q: identifier, include_contacts: true }
    });

    const found = res.data?.payload?.find(c => c.identifier === identifier);
    if (found) return found.id;
  } catch (_) {}

  const res = await cwApi.post('/contacts', { name, identifier });
  return res.data.id;
}

async function findOrCreateConversation(chatKey, contactId) {
  if (conversationMap.has(chatKey)) return conversationMap.get(chatKey);

  const existing = await cwApi.get(`/contacts/${contactId}/conversations`);
  const open = existing.data?.payload?.find(
    c => c.inbox_id === CHATWOOT_INBOX_ID && c.status !== 'resolved'
  );

  if (open) {
    conversationMap.set(chatKey, open.id);
    return open.id;
  }

  const res = await cwApi.post('/conversations', {
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contactId
  });

  const convId = res.data.id;
  conversationMap.set(chatKey, convId);

  if (chatNameMap.has(chatKey)) {
    try {
      await cwApi.patch(`/conversations/${convId}`, {
        name: chatNameMap.get(chatKey)
      });
    } catch (_) {}
  }

  return convId;
}

async function sendMediaToChatwoot(convId, url, type, caption) {
  try {
    const fileRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const buffer = Buffer.from(fileRes.data);
    const mime = fileRes.headers['content-type'] || 'application/octet-stream';
    const ext = detectExtension(mime);

    const form = new FormData();
    form.append('attachments[]', buffer, {
      filename: `file.${ext}`,
      contentType: mime
    });
    form.append('message_type', 'incoming');
    form.append('private', 'false');
    if (caption) form.append('content', caption);

    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT}/conversations/${convId}/messages`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          api_access_token: CHATWOOT_TOKEN
        },
        timeout: 30000
      }
    );

    console.log(`[MEDIA->CW] uploaded ${type || 'file'} to conv ${convId}`);
  } catch (err) {
    console.error('[MEDIA->CW ERROR]', err.response?.status, err.response?.data || err.message);
  }
}

async function initBaselineForConversation(convId) {
  if (chatwootBaselineMap.has(String(convId))) return;

  try {
    const res = await cwApi.get(`/conversations/${convId}/messages`);
    const messages = Array.isArray(res.data?.payload) ? res.data.payload : [];
    const maxId = messages.reduce((acc, m) => Math.max(acc, Number(m?.id || 0)), 0);
    chatwootBaselineMap.set(String(convId), maxId);
    console.log('[CW BASELINE NEW CONV]', { convId, maxId });
  } catch (e) {
    console.error('[CW BASELINE NEW CONV ERROR]', e.response?.status, e.response?.data || e.message);
  }
}

async function handleIncoming(update) {
  const msg = update.message;
  const sender = msg.sender;
  if (sender?.is_bot) return;

  const chat = msg.recipient;
  const userId = sender?.user_id || sender?.id || null;
  const chatId = chat?.chat_id || null;
  const chatType = chat?.chat_type || 'dialog';
  const isGroup = chatType !== 'dialog';

  if (!userId && !chatId) {
    console.log('[SKIP]', JSON.stringify(update));
    return;
  }

  const userName = sender?.name || `Пользователь ${userId || chatId}`;
  const text = msg.body?.text;
  const mid = msg.body?.mid;
  const attachments = msg.body?.attachments || [];

  if (!text && attachments.length === 0) return;

  let chatKey;
  let contactIdentifier;
  let contactName;

  if (isGroup) {
    const chatTitle = await getChatTitle(chatId);
    chatKey = `chat_${chatId}`;
    contactIdentifier = `max_chat_${chatId}`;
    contactName = chatTitle;
    chatNameMap.set(chatKey, chatTitle);
  } else {
    const privateKey = userId || chatId;
    chatKey = `user_${privateKey}`;
    contactIdentifier = `max_${privateKey}`;
    contactName = userName;
    chatNameMap.set(chatKey, contactName);
  }

  const contactId = await findOrCreateContact(contactIdentifier, contactName);
  const convId = await findOrCreateConversation(chatKey, contactId);

  reverseMap.set(convId, {
    chatKey,
    chatId: isGroup ? chatId : null,
    userId,
    isGroup
  });
  saveReverseMap();

  await initBaselineForConversation(convId);

  if (mid) lastMidMap.set(convId, mid);

  const prefix = isGroup ? `${userName}: ` : '';

  if (attachments.length > 0) {
    for (const att of attachments) {
      const url = getAttachmentUrl(att);
      if (url) {
        await sendMediaToChatwoot(convId, url, att.type, prefix + (text || ''));
      }
    }
    return;
  }

  if (text) {
    await cwApi.post(`/conversations/${convId}/messages`, {
      content: prefix + text,
      message_type: 'incoming',
      private: false
    });
  }
}

async function sendMediaToMax(info, fileUrl, replyMid) {
  try {
    const internalUrl = fileUrl.replace(/https?:\/\/[^\/]+/, 'http://chatwoot:3000');
    console.log('[MEDIA->MAX] downloading:', internalUrl);

    const fileRes = await axios.get(internalUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const buffer = Buffer.from(fileRes.data);
    const mime = fileRes.headers['content-type'] || 'application/octet-stream';
    const mediaType = detectMediaType(mime);
    const ext = detectExtension(mime);

    const uploadInitRes = await maxApi.post('/uploads', null, {
      params: { type: mediaType },
      timeout: 30000
    });

    console.log('[UPLOAD INIT RESPONSE]', JSON.stringify(uploadInitRes.data));

    const uploadUrl =
      uploadInitRes.data?.url ||
      uploadInitRes.data?.upload_url ||
      uploadInitRes.data?.endpoint ||
      uploadInitRes.data?.uploadUrl ||
      null;

    if (!uploadUrl) {
      throw new Error('No upload URL in /uploads response');
    }

    const uploadForm = new FormData();
    uploadForm.append('data', buffer, {
      filename: `file.${ext}`,
      contentType: mime
    });

    const uploadBinaryRes = await axios.post(uploadUrl, uploadForm, {
      headers: uploadForm.getHeaders(),
      timeout: 30000,
      maxBodyLength: Infinity
    });

    console.log('[UPLOAD BINARY RESPONSE]', JSON.stringify(uploadBinaryRes.data || {}));

    const uploadedPhotos = uploadBinaryRes.data?.photos || null;
    const finalToken =
      uploadBinaryRes.data?.token ||
      uploadBinaryRes.data?.file_token ||
      null;

    let attachmentPayload;

    if (mediaType === 'image') {
      if (uploadedPhotos && Object.keys(uploadedPhotos).length > 0) {
        attachmentPayload = { photos: uploadedPhotos };
      } else if (finalToken) {
        attachmentPayload = { token: finalToken };
      } else {
        throw new Error('No image payload from upload response');
      }
    } else {
      if (!finalToken) {
        throw new Error('No token for non-image attachment');
      }
      attachmentPayload = { token: finalToken };
    }

    const body = {
      attachments: [
        {
          type: mediaType,
          payload: attachmentPayload
        }
      ]
    };

    if (replyMid) {
      body.link = { type: 'reply', mid: replyMid };
    }

    const sendRes = info.isGroup && info.chatId
      ? await maxApi.post('/messages', body, {
          params: { chat_id: info.chatId },
          timeout: 30000
        })
      : await maxApi.post('/messages', body, {
          params: { user_id: info.userId },
          timeout: 30000
        });

    console.log('[MEDIA->MAX] sent OK', JSON.stringify(sendRes.data || {}));
  } catch (err) {
    console.error(
      '[MEDIA->MAX ERROR]',
      err.response?.status,
      JSON.stringify(err.response?.data || {}),
      err.message
    );
  }
}

async function sendToMax(info, text, replyMid) {
  const body = { text };

  if (replyMid) {
    body.link = { type: 'reply', mid: replyMid };
  }

  if (info.isGroup && info.chatId) {
    await maxApi.post('/messages', body, {
      params: { chat_id: info.chatId },
      timeout: 30000
    });
  } else {
    await maxApi.post('/messages', body, {
      params: { user_id: info.userId },
      timeout: 30000
    });
  }
}

let marker;
let cwPollingStarted = false;

async function pollMax() {
  try {
    const params = { timeout: 30, types: 'message_created' };
    if (marker) params.marker = marker;

    const res = await maxApi.get('/updates', { params, timeout: 35000 });
    marker = res.data.marker;

    for (const update of res.data.updates || []) {
      if (update.update_type === 'message_created') {
        await handleIncoming(update);
      }
    }
  } catch (err) {
    console.error('[poll MAX error]', err.response?.status, err.response?.data || err.message);
  }

  setImmediate(pollMax);
}

async function initChatwootBaselines() {
  try {
    for (const [convId] of reverseMap.entries()) {
      try {
        const res = await cwApi.get(`/conversations/${convId}/messages`);
        const messages = Array.isArray(res.data?.payload) ? res.data.payload : [];
        const maxId = messages.reduce((acc, m) => Math.max(acc, Number(m?.id || 0)), 0);
        chatwootBaselineMap.set(String(convId), maxId);
        console.log('[CW BASELINE]', { convId, maxId });
      } catch (err) {
        console.error('[CW BASELINE ERROR]', convId, err.response?.status, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('[CW BASELINE INIT ERROR]', err.response?.status, err.response?.data || err.message);
  }
}

async function processChatwootMessage(convId, info, message) {
  const msgId = message?.id;
  if (msgId === undefined || msgId === null) return;

  const text = normalizeContent(message?.content);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const hasText = !!text;
  const hasAttachments = attachments.length > 0;

  if (!hasText && !hasAttachments) return;
  if (message?.message_type === 'incoming' || message?.message_type === 0) return;

  const state = getProcessed(msgId);
  const isReply = !!(message?.content_attributes?.in_reply_to);
  const replyMid = isReply ? lastMidMap.get(convId) : null;

  if (hasAttachments) {
    console.log('[CW ATTACHMENT MESSAGE]', { convId, msgId, attachmentsCount: attachments.length });
  }

  if (hasText && !state.textSent) {
    await sendToMax(info, text, replyMid);
    markProcessed(msgId, { textSent: true });
    console.log('[CW POLL] text sent', { convId, msgId });
  }

  if (hasAttachments && !getProcessed(msgId).attachmentsSent) {
    for (const att of attachments) {
      const fileUrl = getAttachmentUrl(att);
      if (fileUrl) {
        console.log('[CW POLL ATTACHMENT URL]', { convId, msgId, fileUrl });
        await sendMediaToMax(info, fileUrl, replyMid);
      } else {
        console.log('[CW POLL attachment skip] no file url', JSON.stringify(att));
      }
    }

    markProcessed(msgId, { attachmentsSent: true });
    console.log('[CW POLL] attachments sent', { convId, msgId, count: attachments.length });
  } else if (!hasAttachments) {
    markProcessed(msgId, { attachmentsSent: true });
  }

  if (!hasText) {
    markProcessed(msgId, { textSent: true });
  }
}

async function pollChatwootOutgoing() {
  try {
    pruneProcessedMap();

    for (const [convId, info] of reverseMap.entries()) {
      try {
        const res = await cwApi.get(`/conversations/${convId}/messages`);
        const messages = Array.isArray(res.data?.payload) ? res.data.payload : [];

        messages.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));

        const baseline = chatwootBaselineMap.get(String(convId)) || 0;

        for (const message of messages) {
          const msgId = Number(message?.id || 0);
          if (msgId <= baseline) continue;

          await processChatwootMessage(convId, info, message);

          const currentBaseline = chatwootBaselineMap.get(String(convId)) || 0;
          if (msgId > currentBaseline) {
            chatwootBaselineMap.set(String(convId), msgId);
          }
        }
      } catch (err) {
        console.error('[CW POLL conversation error]', convId, err.response?.status, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('[CW POLL error]', err.response?.status, err.response?.data || err.message);
  }

  setTimeout(pollChatwootOutgoing, 5000);
}

const app = express();
app.use(express.json({ limit: '20mb' }));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const {
    event,
    message_type,
    content,
    conversation,
    content_attributes,
    attachments: webhookAttachments
  } = req.body;

  if (event !== 'message_created' || message_type !== 'outgoing') return;

  const convId = conversation?.id;
  const msgId = req.body?.id;

  let info = reverseMap.get(convId);

  if (!info) {
    try {
      const r = await cwApi.get(`/conversations/${convId}`);
      const ident = r.data?.meta?.sender?.identifier;

      if (!ident) {
        console.warn('[webhook] no identifier for conv=' + convId);
        return;
      }

      const isGroup = ident.startsWith('max_chat_');
      const rawId = ident.replace('max_chat_', '').replace('max_', '');

      info = {
        chatKey: ident,
        chatId: isGroup ? rawId : null,
        userId: isGroup ? null : rawId,
        isGroup
      };

      reverseMap.set(convId, info);
      saveReverseMap();
      await initBaselineForConversation(convId);
    } catch (e) {
      console.warn('[webhook] restore error:', e.message);
      return;
    }
  }

  const isReply = !!(content_attributes?.in_reply_to);
  const replyMid = isReply ? lastMidMap.get(convId) : null;

  try {
    const fullMsg = await cwApi.get(`/conversations/${convId}/messages`);
    const messages = fullMsg.data?.payload || [];
    const thisMsg = messages.find(m => String(m.id) === String(msgId));

    let attachments = thisMsg?.attachments || [];
    if ((!attachments || attachments.length === 0) && webhookAttachments) {
      attachments = webhookAttachments;
    }

    const normalizedContent = normalizeContent(content);

    if (normalizedContent && !getProcessed(msgId).textSent) {
      await sendToMax(info, normalizedContent, replyMid);
      markProcessed(msgId, { textSent: true });
    }

    if (attachments.length > 0 && !getProcessed(msgId).attachmentsSent) {
      for (const att of attachments) {
        const fileUrl = getAttachmentUrl(att);
        if (fileUrl) {
          await sendMediaToMax(info, fileUrl, null);
        }
      }
      markProcessed(msgId, { attachmentsSent: true });
    } else if (attachments.length === 0) {
      markProcessed(msgId, { attachmentsSent: true });
    }

    if (!normalizedContent) {
      markProcessed(msgId, { textSent: true });
    }
  } catch (err) {
    console.error('[fetch attachments error]', err.response?.status, err.response?.data || err.message);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

async function main() {
  loadReverseMap();
  loadProcessedMap();

  console.log('Bridge started');
  app.listen(3000, () => console.log('Webhook listening on :3000'));

  await initChatwootBaselines();

  pollMax();

  if (!cwPollingStarted) {
    cwPollingStarted = true;
    setTimeout(pollChatwootOutgoing, 3000);
    console.log('Chatwoot outgoing polling enabled');
  }
}

main().catch(err => {
  console.error('Fatal:', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});